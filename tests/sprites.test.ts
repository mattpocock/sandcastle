import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sprites } from "@ai-hero/sandcastle/sandboxes/sprites";

// sprites() runs the real @fly/sprites SDK against a fake Sprites API: `fetch`
// and `WebSocket` are stubbed at that network boundary. The fake API creates
// and deletes Sprites and stores files written through the filesystem API.
// An exec WebSocket speaks the SDK's frame protocol: the client sends stdin
// frames (0) and a stdin EOF (4); the fake then answers with stdout (1) and
// stderr (2) frames, one per turn of the event loop, and an exit frame (3).
// A negative exit code closes the socket with no exit frame instead, as a
// dropped connection does. Each command's behaviour comes from `api.run`.

interface Outcome {
  readonly stdout?: readonly string[];
  readonly stderr?: string;
  readonly exitCode: number;
}

interface Exec {
  readonly line: string;
  readonly cwd: string | null;
  readonly env: Record<string, string>;
  readonly stdin: string;
}

const api = {
  tokens: new Set<string>(),
  created: new Array<string>(),
  deleted: new Array<string>(),
  execs: new Array<Exec>(),
  files: new Map<string, string>(),
  createFails: false,
  /** Fail the next exec WebSocket before it opens, as a network error does. */
  connectFails: false,
  run: (_line: string, _stdin: string): Outcome => ({ exitCode: 0 }),
  /** Called with each stdout chunk as the fake sends it. */
  onChunk: (_chunk: string): void => undefined,
};

const bearer = (headers: unknown): string => {
  const auth = new Headers(
    headers !== null && typeof headers === "object"
      ? Object.entries(headers)
      : [],
  ).get("authorization");
  return auth?.replace("Bearer ", "") ?? "";
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const CreateRequest = z.object({ name: z.string() });

const createSprite = async (body: Response): Promise<Response> => {
  const request = CreateRequest.parse(await body.json());
  api.created.push(request.name);
  if (api.createFails) {
    return new Response("capacity exhausted", { status: 500 });
  }
  return json({ id: `id-${request.name}`, name: request.name }, 201);
};

const fsRequest = async (
  method: string,
  url: URL,
  body: Response,
): Promise<Response> => {
  const path = url.searchParams.get("path") ?? "";
  if (method === "PUT") {
    api.files.set(path, await body.text());
    return new Response(null, { status: 200 });
  }
  const content = api.files.get(path);
  return content === undefined
    ? new Response("not found", { status: 404 })
    : new Response(content);
};

const fakeFetch = async (
  input: string | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = new Response(init?.body);
  api.tokens.add(bearer(init?.headers));
  if (method === "POST" && url.pathname === "/v1/sprites") {
    return createSprite(body);
  }
  if (url.pathname.includes("/fs/")) {
    return fsRequest(method, url, body);
  }
  if (method === "DELETE") {
    api.deleted.push(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
    return new Response(null, { status: 204 });
  }
  return new Response("unexpected", { status: 500 });
};

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  private readonly url: URL;
  private readonly stdin: Buffer[] = [];

  constructor(url: string, init: { headers: unknown }) {
    super();
    this.url = new URL(url);
    api.tokens.add(bearer(init.headers));
    const fails = api.connectFails && this.url.pathname.endsWith("/exec");
    api.connectFails = false;
    setImmediate(() => {
      if (fails) {
        this.readyState = 3;
        this.dispatchEvent(
          Object.assign(new Event("error"), {
            message: "Received network error or non-101 status code.",
          }),
        );
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: Buffer): void {
    if (data[0] === 0) {
      this.stdin.push(data.subarray(1));
    }
    if (data[0] === 4) {
      this.respond();
    }
  }

  close(): void {
    this.readyState = 3;
  }

  private respond(): void {
    const stdin = Buffer.concat(this.stdin).toString();
    const params = this.url.searchParams;
    const line = params.getAll("cmd")[2] ?? "";
    const env = Object.fromEntries(
      params.getAll("env").map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
    );
    api.execs.push({ line, cwd: params.get("dir"), env, stdin });
    const outcome = api.run(line, stdin);
    this.sendChunks([...(outcome.stdout ?? [])], () => {
      if (outcome.stderr !== undefined) {
        this.frame(2, Buffer.from(outcome.stderr));
      }
      if (outcome.exitCode < 0) {
        this.dispatchEvent(new Event("close"));
      } else {
        this.frame(3, Buffer.from([outcome.exitCode]));
      }
    });
  }

  private sendChunks(chunks: string[], done: () => void): void {
    const [chunk, ...rest] = chunks;
    if (chunk === undefined) {
      done();
      return;
    }
    api.onChunk(chunk);
    this.frame(1, Buffer.from(chunk));
    setImmediate(() => {
      this.sendChunks(rest, done);
    });
  }

  private frame(stream: number, payload: Buffer): void {
    const data = Uint8Array.from([stream, ...payload]).buffer;
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

beforeEach(() => {
  api.tokens.clear();
  api.created.length = 0;
  api.deleted.length = 0;
  api.execs.length = 0;
  api.files.clear();
  api.createFails = false;
  api.connectFails = false;
  api.run = () => ({ exitCode: 0 });
  api.onChunk = () => undefined;
  vi.stubGlobal("fetch", fakeFetch);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubEnv("SPRITES_TOKEN", "");
  vi.stubEnv("SPRITE_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const create = async (env: Record<string, string> = {}) =>
  sprites({ token: "tok-option" }).create({ env });

describe("sprites() lifecycle", () => {
  it("creates a Sprite with the worktree under the Sprite user's home, named by sandboxId", async () => {
    const handle = await create();

    expect(handle.worktreePath).toBe("/home/sprite/workspace");
    expect(handle.sandboxId).toBe(api.created[0]);
    expect(handle.sandboxId).toMatch(/^sandcastle-/u);
    expect(api.execs[0]).toMatchObject({
      line: "mkdir -p /home/sprite/workspace",
      cwd: "/home/sprite",
    });

    await handle.close();
    expect(api.deleted).toStrictEqual([handle.sandboxId]);
  });

  it("deletes the Sprite and rethrows when the worktree folder can't be made", async () => {
    api.run = () => ({ exitCode: 1, stderr: "mkdir: Permission denied\n" });

    await expect(create()).rejects.toThrow(
      "sprites(): could not create /home/sprite/workspace: mkdir: Permission denied",
    );
    expect(api.deleted).toStrictEqual([api.created[0]]);
  });

  it("deletes the Sprite's name and rethrows when creating it fails", async () => {
    api.createFails = true;

    await expect(create()).rejects.toThrow("capacity exhausted");
    expect(api.deleted).toStrictEqual([api.created[0]]);
  });
});

describe("sprites() token", () => {
  it("prefers the token option, then SPRITES_TOKEN, then SPRITE_TOKEN", async () => {
    vi.stubEnv("SPRITES_TOKEN", "tok-plural");
    vi.stubEnv("SPRITE_TOKEN", "tok-singular");
    const fromOption = await create();
    await fromOption.close();
    const fromPlural = await sprites().create({ env: {} });
    await fromPlural.close();
    vi.stubEnv("SPRITES_TOKEN", "");
    const fromSingular = await sprites({ token: "" }).create({ env: {} });
    await fromSingular.close();

    expect([...api.tokens]).toStrictEqual([
      "tok-option",
      "tok-plural",
      "tok-singular",
    ]);
  });

  it("fails before creating anything when no token is set", async () => {
    await expect(sprites().create({ env: {} })).rejects.toThrow(
      "sprites(): no Sprites token. Set SPRITES_TOKEN (or SPRITE_TOKEN), or pass the token option.",
    );
    expect(api.created).toStrictEqual([]);
  });
});

describe("sprites() exec", () => {
  it("streams stdout lines as they arrive, including a last line with no newline", async () => {
    const handle = await create();
    const events: string[] = [];
    api.onChunk = (chunk) => {
      events.push(`chunk ${JSON.stringify(chunk)}`);
    };
    api.run = () => ({
      stdout: ["one\ntw", "o\n", "tail"],
      stderr: "warn",
      exitCode: 0,
    });

    const result = await handle.exec("agent", {
      onLine: (line) => {
        events.push(`line ${line}`);
      },
    });
    await handle.close();

    expect(events).toStrictEqual([
      String.raw`chunk "one\ntw"`,
      "line one",
      String.raw`chunk "o\n"`,
      "line two",
      'chunk "tail"',
      "line tail",
    ]);
    expect(result).toStrictEqual({
      stdout: "one\ntwo\ntail",
      stderr: "warn",
      exitCode: 0,
    });
  });

  it("returns the whole stdout, stderr and exit code when not streamed", async () => {
    const handle = await create();
    api.run = () => ({
      stdout: ["a\n", "b"],
      stderr: "ls: nope\n",
      exitCode: 2,
    });

    const result = await handle.exec("ls nope");
    await handle.close();

    expect(result).toStrictEqual({
      stdout: "a\nb",
      stderr: "ls: nope\n",
      exitCode: 2,
    });
  });

  it("bounds a streamed exec's output tails", async () => {
    const handle = await sprites({
      token: "t",
      maxOutputTailChars: 5,
    }).create({ env: {} });
    api.run = () => ({
      stdout: ["111\n222\n333\n"],
      stderr: "abcdefgh",
      exitCode: 0,
    });

    const result = await handle.exec("x", {
      onLine: () => undefined,
    });
    await handle.close();

    expect(result.stdout).toBe("333");
    expect(result.stderr).toBe("defgh");
  });

  it("pipes stdin and closes it, and sends empty stdin when none is given", async () => {
    const handle = await create();
    api.run = (_line, stdin) => ({ stdout: [stdin], exitCode: 0 });

    const piped = await handle.exec("cat", { stdin: "s-one\ns-two" });
    const empty = await handle.exec("cat");
    await handle.close();

    expect(piped.stdout).toBe("s-one\ns-two");
    expect(empty.stdout).toBe("");
  });

  it("runs in the worktree with the sandbox env, or in the given cwd", async () => {
    const handle = await create({ PROBE: "probe=ok" });

    await handle.exec("pwd");
    await handle.exec("pwd", { cwd: "/tmp" });
    await handle.close();

    expect(
      api.execs.slice(1).map(({ cwd, env }) => ({ cwd, env })),
    ).toStrictEqual([
      { cwd: "/home/sprite/workspace", env: { PROBE: "probe=ok" } },
      { cwd: "/tmp", env: { PROBE: "probe=ok" } },
    ]);
  });

  it("elevates the whole command with sudo", async () => {
    const handle = await create();

    await handle.exec("id -u && echo 'hi'", { sudo: true });
    await handle.close();

    expect(api.execs[1]?.line).toBe(
      String.raw`sudo sh -c 'id -u && echo '\''hi'\'''`,
    );
  });

  it("fails when the connection closes before the command exits", async () => {
    const handle = await create();
    api.run = () => ({ stdout: ["partial"], exitCode: -1 });

    await expect(handle.exec("long-run")).rejects.toThrow(
      "sprites(): the connection closed before the command exited: long-run",
    );
    await handle.close();
  });
});

describe("sprites() exec connection errors", () => {
  it("leaves the exec URL's query string, and so the env values, out of the error", async () => {
    const handle = await create({ SECRET: "abc" });
    const name = z.string().parse(handle.sandboxId);
    api.connectFails = true;

    const rejection: unknown = await handle
      .exec("cat")
      .catch((error: unknown) => error);
    await handle.close();

    const error = z.instanceof(Error).parse(rejection);
    const cause = z.instanceof(Error).parse(error.cause);
    expect(error.message).toBe(
      `sprites(): the connection failed: cat (WebSocket error: Received network error or non-101 status code. (url: wss://api.sprites.dev/v1/sprites/${name}/exec))`,
    );
    expect(cause.message).toContain("WebSocket error");
    // The Sprite's name is random hex, so drop it before looking for "abc".
    const texts = [error.message, error.stack, cause.message, cause.stack].map(
      (text) => String(text).replaceAll(name, "<name>"),
    );
    for (const text of texts) {
      expect(text).not.toContain("abc");
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("env=");
    }
  });
});

describe("sprites() file copy", () => {
  it("copies a file or a directory in, and a file out", async () => {
    const host = await mkdtemp(join(tmpdir(), "sprites-copy-"));
    await writeFile(join(host, "bundle"), "bundle-bytes");
    await mkdir(join(host, "dir", "nested"), { recursive: true });
    await writeFile(join(host, "dir", "top.txt"), "top");
    await writeFile(join(host, "dir", "nested", "deep.txt"), "deep");
    const handle = await create();

    await handle.copyIn(join(host, "bundle"), "/tmp/b.bundle");
    await handle.copyIn(join(host, "dir"), "/home/sprite/workspace/d");
    await handle.copyFileOut("/tmp/b.bundle", join(host, "out", "b"));
    await handle.close();

    expect(Object.fromEntries(api.files)).toStrictEqual({
      "/home/sprite/workspace/d/nested/deep.txt": "deep",
      "/home/sprite/workspace/d/top.txt": "top",
      "/tmp/b.bundle": "bundle-bytes",
    });
    await expect(readFile(join(host, "out", "b"), "utf8")).resolves.toBe(
      "bundle-bytes",
    );
  });
});
