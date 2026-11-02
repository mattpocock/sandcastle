import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { e2b } from "@ai-hero/sandcastle/sandboxes/e2b";

// e2b() runs the real `e2b` SDK against a fake E2B on localhost: one server
// plays both the E2B API (create and kill) and the sandbox's envd (commands
// over Connect JSON, and files). envd runs each command in a real local
// `bash`, whose HOME is a temp folder, so `$HOME/workspace` and the /tmp
// paths are real paths on this machine. Output streams back as it arrives.

const StartRequest = z.object({
  process: z.object({
    cmd: z.string(),
    args: z.array(z.string()),
    cwd: z.string().optional(),
  }),
  stdin: z.boolean().optional(),
});
const PidRequest = z.object({
  process: z.object({ pid: z.number() }),
  input: z.object({ stdin: z.string() }).optional(),
});

interface Started {
  readonly command: string;
  readonly cwd: string | undefined;
  readonly user: string;
  readonly stdin: boolean;
}

interface World {
  home: string;
  failMkdir: boolean;
  readonly created: Record<string, unknown>[];
  readonly killed: string[];
  readonly started: Started[];
  readonly processes: Map<number, ChildProcess>;
}

const world: World = {
  home: "",
  failMkdir: false,
  created: [],
  killed: [],
  started: [],
  processes: new Map(),
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const data: unknown = chunk;
    if (data instanceof Buffer) {
      chunks.push(data);
    }
  }
  return Buffer.concat(chunks);
};

/** One Connect stream frame: a flags byte, a length, then JSON. */
const frame = (flags: number, message: unknown): Buffer => {
  const json = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(5);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(json.length, 1);
  return Buffer.concat([head, json]);
};

/** The user an envd request runs as, from its Basic auth header. */
const userOf = (req: IncomingMessage): string => {
  const auth = req.headers.authorization ?? "";
  const decoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();
  const [user = ""] = decoded.split(":");
  return user === "" ? "user" : user;
};

let nextPid = 100;

const startProcess = async (req: IncomingMessage, res: ServerResponse) => {
  const body = await readBody(req);
  const { process: proc, stdin } = StartRequest.parse(
    JSON.parse(body.subarray(5).toString()),
  );
  const command = proc.args.at(-1) ?? "";
  world.started.push({
    command,
    cwd: proc.cwd,
    user: userOf(req),
    stdin: stdin === true,
  });
  res.writeHead(200, { "content-type": "application/connect+json" });
  if (world.failMkdir && command.includes("mkdir -p")) {
    res.end(frame(2, { error: { code: "internal", message: "disk full" } }));
    return;
  }
  nextPid += 1;
  const pid = nextPid;
  const child = spawn("bash", ["-c", command], {
    cwd: proc.cwd,
    env: { ...process.env, HOME: world.home },
  });
  world.processes.set(pid, child);
  if (stdin !== true) {
    child.stdin.end();
  }
  res.write(frame(0, { event: { start: { pid } } }));
  for (const name of ["stdout", "stderr"] as const) {
    child[name].on("data", (chunk: Buffer) => {
      res.write(
        frame(0, { event: { data: { [name]: chunk.toString("base64") } } }),
      );
    });
  }
  child.on("close", (code: number | null) => {
    const end = {
      exitCode: code ?? 1,
      exited: true,
      status: `exit status ${String(code)}`,
    };
    res.write(frame(0, { event: { end } }));
    res.end(frame(2, {}));
  });
};

const unary = async (req: IncomingMessage, res: ServerResponse) => {
  const raw = await readBody(req);
  const body = PidRequest.parse(JSON.parse(raw.toString()));
  const child = world.processes.get(body.process.pid);
  if (req.url?.endsWith("/SendInput") === true && body.input !== undefined) {
    child?.stdin?.write(Buffer.from(body.input.stdin, "base64"));
  } else if (req.url?.endsWith("/CloseStdin") === true) {
    child?.stdin?.end();
  } else {
    child?.kill();
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
};

const files = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const path = url.searchParams.get("path") ?? "";
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(await readFile(path));
    return;
  }
  // e2b() uploads with octet-stream, so the body is the file.
  await writeFile(path, await readBody(req));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify([{ name: "file", path, type: "file" }]));
};

let nextSandbox = 0;

const api = async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "POST") {
    const body = await readBody(req);
    const params = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(String(body)));
    world.created.push({ ...params, apiKey: req.headers["x-api-key"] });
    nextSandbox += 1;
    const sandboxID = `e2b-sbx-${String(nextSandbox)}`;
    res.writeHead(201, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        sandboxID,
        templateID: "base",
        clientID: "client",
        envdVersion: "0.6.2",
      }),
    );
    return;
  }
  world.killed.push(req.url?.split("/").at(-1) ?? "");
  res.writeHead(204);
  res.end();
};

const route = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const url = req.url ?? "";
  if (url.startsWith("/process.Process/Start")) {
    return startProcess(req, res);
  }
  if (url.startsWith("/process.Process/")) {
    return unary(req, res);
  }
  if (url.startsWith("/files")) {
    return files(req, res);
  }
  return api(req, res);
};

let server: Server;
let baseUrl = "";

/** The provider; E2B_API_URL and E2B_SANDBOX_URL point the SDK at the fake. */
const provider = (options: Parameters<typeof e2b>[0] = {}) =>
  e2b({ apiKey: "e2b_fake", ...options });

describe.skipIf(process.platform === "win32")("e2b()", () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      void route(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake E2B has no port");
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  beforeEach(async () => {
    world.home = await mkdtemp(join(tmpdir(), "e2b-home-"));
    world.failMkdir = false;
    world.created.length = 0;
    world.killed.length = 0;
    world.started.length = 0;
    vi.stubEnv("E2B_API_URL", baseUrl);
    vi.stubEnv("E2B_SANDBOX_URL", baseUrl);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("creates a sandbox that is killed, not paused, on timeout and on close()", async () => {
    const handle = await provider({ template: "claude" }).create({
      env: { FOO: "bar" },
    });

    expect(world.created).toStrictEqual([
      expect.objectContaining({
        templateID: "claude",
        envVars: { FOO: "bar" },
        timeout: 1800,
        autoPause: false,
        apiKey: "e2b_fake",
      }),
    ]);
    expect(handle.worktreePath).toBe(join(world.home, "workspace"));
    expect(handle.sandboxId).toMatch(/^e2b-sbx-\d+$/u);

    await handle.close();
    expect(world.killed).toStrictEqual([handle.sandboxId]);
  });

  it("passes timeoutMs through, and reads E2B_API_KEY when apiKey is empty", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b_from_env");
    await provider({ apiKey: "", timeoutMs: 60_000 }).create({ env: {} });

    expect(world.created).toStrictEqual([
      expect.objectContaining({ timeout: 60, apiKey: "e2b_from_env" }),
    ]);
  });

  it("kills the sandbox when setting up the worktree fails", async () => {
    world.failMkdir = true;

    await expect(provider().create({ env: {} })).rejects.toThrow("disk full");
    expect(world.created).toHaveLength(1);
    expect(world.killed).toHaveLength(1);
  });

  it("streams stdout lines live, including a last line with no newline", async () => {
    const handle = await provider().create({ env: {} });
    const lines: string[] = [];

    const result = await handle.exec(
      String.raw`printf 'one\ntwo\n'; printf tail`,
      {
        onLine: (line) => {
          lines.push(line);
        },
      },
    );

    expect(lines).toStrictEqual(["one", "two", "tail"]);
    expect(result).toStrictEqual({
      stdout: "one\ntwo\ntail",
      stderr: "",
      exitCode: 0,
    });
    expect(world.started.at(-1)?.cwd).toBe(handle.worktreePath);
  });

  it("pipes stdin and closes it", async () => {
    const handle = await provider().create({ env: {} });

    const result = await handle.exec("cat; echo done", { stdin: "prompt\n" });
    const empty = await handle.exec("cat | wc -c", { stdin: "" });

    expect(result.stdout).toBe("prompt\ndone\n");
    expect(empty.stdout.trim()).toBe("0");
    expect(world.started.at(-1)?.stdin).toBe(true);
  });

  it("returns a non-zero exit with its output", async () => {
    const handle = await provider().create({ env: {} });

    const buffered = await handle.exec("echo out; echo err >&2; exit 3");
    const streamed = await handle.exec("echo err >&2; exit 4", {
      onLine: () => undefined,
    });

    expect(buffered).toStrictEqual({
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 3,
    });
    expect(streamed).toStrictEqual({
      stdout: "",
      stderr: "err\n",
      exitCode: 4,
    });
  });

  it("runs sudo commands as root, in the given cwd", async () => {
    const handle = await provider().create({ env: {} });

    await handle.exec("true", { sudo: true, cwd: "/" });

    expect(world.started.at(-1)).toMatchObject({ user: "root", cwd: "/" });
  });

  it("copies a directory and a file in, keeping modes, and a file out", async () => {
    const handle = await provider().create({ env: {} });
    const host = await mkdtemp(join(tmpdir(), "e2b-host-"));
    await mkdir(join(host, "dir", "sub"), { recursive: true });
    await writeFile(join(host, "dir", "sub", "a.txt"), "a");
    await writeFile(join(host, "run.sh"), "#!/bin/sh\n");
    await chmod(join(host, "run.sh"), 0o755);

    await handle.copyIn(join(host, "dir"), join(handle.worktreePath, "copy"));
    await handle.copyIn(join(host, "run.sh"), join(world.home, "run.sh"));
    await handle.copyFileOut(
      join(handle.worktreePath, "copy", "sub", "a.txt"),
      join(host, "out", "a.txt"),
    );

    const copied = await stat(join(world.home, "run.sh"));
    expect(copied.mode % 0o1000).toBe(0o755);
    await expect(readFile(join(host, "out", "a.txt"), "utf8")).resolves.toBe(
      "a",
    );
  });
});
