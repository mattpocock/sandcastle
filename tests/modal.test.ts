import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { modal } from "@ai-hero/sandcastle/sandboxes/modal";
import type { ModalClientParams } from "modal";

// modal() against a fake `modal` SDK. The fake sandbox's filesystem lives in a
// host temp dir (`root`): sandbox path `/x` is `${root}/x`. A command's output
// comes from `respond`, which sees the argv, workdir and the stdin the
// provider wrote. The fake only answers once stdin is closed, as a real
// process reading stdin to EOF would, so a provider that never closes stdin
// hangs the test.

interface Reply {
  readonly stdout?: readonly string[];
  readonly stderr?: string;
  readonly exitCode?: number;
}

interface ExecCall {
  readonly argv: readonly string[];
  readonly workdir: string | undefined;
  readonly stdin: string;
}

interface FakeState {
  root: string;
  respond: (call: ExecCall) => Reply;
  execCalls: ExecCall[];
  clientParams: unknown[];
  appNames: unknown[];
  createCalls: { image: unknown; params: Record<string, unknown> }[];
  terminated: string[];
  clientsClosed: number;
  makeDirectoryError: Error | undefined;
  createError: Error | undefined;
}

const fake = vi.hoisted(
  (): FakeState => ({
    root: "",
    respond: () => ({}),
    execCalls: [],
    clientParams: [],
    appNames: [],
    createCalls: [],
    terminated: [],
    clientsClosed: 0,
    makeDirectoryError: undefined,
    createError: undefined,
  }),
);

vi.mock(import("modal"), async () => {
  const fs = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const onHost = (sandboxPath: string) => nodePath.join(fake.root, sandboxPath);

  const textStream = (chunks: readonly string[]) => {
    const stream = new ReadableStream<string>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    return Object.assign(stream, {
      readText: async () => {
        let text = "";
        for await (const chunk of stream) {
          text += chunk;
        }
        return text;
      },
    });
  };

  /** A process whose output appears only once its stdin is closed. */
  const fakeProcess = (argv: string[], workdir: string | undefined) => {
    let stdin = "";
    let answer: (reply: Reply) => void = () => undefined;
    const replied = new Promise<Reply>((resolve) => {
      answer = resolve;
    });
    const later = (pick: (reply: Reply) => readonly string[]) => {
      const stream = new ReadableStream<string>({
        async start(controller) {
          for (const chunk of pick(await replied)) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      return Object.assign(stream, {
        readText: async () => textStream(pick(await replied)).readText(),
      });
    };
    return {
      stdin: {
        writeText: async (text: string) => {
          stdin += text;
        },
        close: async () => {
          const call = { argv, workdir, stdin };
          fake.execCalls.push(call);
          answer(fake.respond(call));
        },
      },
      stdout: later((reply) => reply.stdout ?? []),
      stderr: later((reply) =>
        reply.stderr === undefined ? [] : [reply.stderr],
      ),
      wait: async () => {
        const reply = await replied;
        return reply.exitCode ?? 0;
      },
    };
  };

  const fakeSandbox = (sandboxId: string) => ({
    sandboxId,
    exec: async (argv: string[], params?: { workdir?: string }) =>
      fakeProcess(argv, params?.workdir),
    filesystem: {
      makeDirectory: async (remotePath: string) => {
        if (fake.makeDirectoryError !== undefined) {
          throw fake.makeDirectoryError;
        }
        await fs.mkdir(onHost(remotePath), { recursive: true });
      },
      copyFromLocal: async (localPath: string, remotePath: string) => {
        await fs.mkdir(nodePath.dirname(onHost(remotePath)), {
          recursive: true,
        });
        await fs.copyFile(localPath, onHost(remotePath));
      },
      copyToLocal: async (remotePath: string, localPath: string) => {
        await fs.mkdir(nodePath.dirname(localPath), { recursive: true });
        await fs.copyFile(onHost(remotePath), localPath);
      },
    },
    terminate: async () => {
      fake.terminated.push(sandboxId);
    },
  });

  const registryImage = (tag: string, commands: readonly string[] = []) => ({
    tag,
    commands,
    dockerfileCommands: (more: readonly string[]) =>
      registryImage(tag, [...commands, ...more]),
  });

  /** A client: `new ModalClient(params)` returns it, as the fake below. */
  const fakeClient = (params: unknown) => {
    fake.clientParams.push(params);
    return {
      apps: {
        fromName: async (name: string, appParams: unknown) => {
          fake.appNames.push({ name, params: appParams });
          return { appId: `ap-${name}` };
        },
      },
      images: { fromRegistry: (tag: string) => registryImage(tag) },
      sandboxes: {
        create: async (
          _app: unknown,
          image: unknown,
          createParams: Record<string, unknown>,
        ) => {
          if (fake.createError !== undefined) {
            throw fake.createError;
          }
          fake.createCalls.push({ image, params: createParams });
          return fakeSandbox(`sb-${fake.createCalls.length}`);
        },
      },
      close: () => {
        fake.clientsClosed += 1;
      },
    };
  };

  // `new ModalClient(params)` gives the fake client: a constructor that
  // returns an object makes `new` give that object. The fake covers only what
  // modal() calls, so it returns what vitest's own untyped mock returns, not
  // a real ModalClient.
  type UntypedMock = NonNullable<Parameters<typeof vi.fn>[0]>;
  const ModalClient =
    vi.fn<(params: ModalClientParams) => ReturnType<UntypedMock>>(fakeClient);

  return { ModalClient };
});

const lastCreate = () => {
  const call = fake.createCalls.at(-1);
  if (call === undefined) {
    throw new Error("sandboxes.create was not called");
  }
  return call;
};

beforeEach(async () => {
  fake.root = await mkdtemp(path.join(tmpdir(), "modal-fake-"));
  fake.respond = () => ({});
  fake.execCalls = [];
  fake.clientParams = [];
  fake.appNames = [];
  fake.createCalls = [];
  fake.terminated = [];
  fake.clientsClosed = 0;
  fake.makeDirectoryError = undefined;
  fake.createError = undefined;
});

describe("modal()", () => {
  it("is an isolated provider named 'modal'", () => {
    const provider = modal();

    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("modal");
  });

  it("tells Claude Code it is in a sandbox, since Modal runs commands as root, and merges the env option over it", () => {
    expect(modal().env).toStrictEqual({ IS_SANDBOX: "1" });
    expect(modal({ env: { A: "1", IS_SANDBOX: "0" } }).env).toStrictEqual({
      A: "1",
      IS_SANDBOX: "0",
    });
  });
});

describe("modal() create", () => {
  it("creates a sandbox in the 'sandcastle' app, from Node LTS with Claude Code, for an hour, with the resolved env", async () => {
    const handle = await modal().create({ env: { KEY: "value" } });

    expect(fake.appNames).toStrictEqual([
      { name: "sandcastle", params: { createIfMissing: true } },
    ]);
    expect(lastCreate().image).toMatchObject({
      tag: "node:24-bookworm",
      commands: [expect.stringContaining("@anthropic-ai/claude-code")],
    });
    expect(lastCreate().params).toStrictEqual({
      timeoutMs: 3_600_000,
      env: { KEY: "value" },
    });
    expect(handle.worktreePath).toBe("/workspace");
    expect(handle.sandboxId).toBe("sb-1");
  });

  it("uses a registry tag as the image, as is", async () => {
    await modal({ image: "python:3.13" }).create({ env: {} });

    expect(lastCreate().image).toMatchObject({
      tag: "python:3.13",
      commands: [],
    });
  });

  it("passes appName, timeoutMs and create options through; create.env wins", async () => {
    await modal({
      appName: "my-app",
      timeoutMs: 120_000,
      create: { cpu: 2, env: { KEY: "from-create" } },
    }).create({ env: { KEY: "resolved", OTHER: "o" } });

    expect(fake.appNames).toStrictEqual([
      { name: "my-app", params: { createIfMissing: true } },
    ]);
    expect(lastCreate().params).toStrictEqual({
      cpu: 2,
      timeoutMs: 120_000,
      env: { KEY: "from-create", OTHER: "o" },
    });
  });

  it("passes only the credentials that are set, so the SDK falls back to MODAL_TOKEN_ID/MODAL_TOKEN_SECRET", async () => {
    await modal().create({ env: {} });
    await modal({
      tokenId: "ak-1",
      tokenSecret: "",
      environment: "dev",
    }).create({ env: {} });

    expect(fake.clientParams).toStrictEqual([
      {},
      { tokenId: "ak-1", environment: "dev" },
    ]);
  });

  it("terminates the sandbox and closes the client when the worktree folder can't be made", async () => {
    fake.makeDirectoryError = new Error("Permission denied");

    await expect(modal().create({ env: {} })).rejects.toThrow(
      "modal(): could not create /workspace: Permission denied",
    );
    expect(fake.terminated).toStrictEqual(["sb-1"]);
    expect(fake.clientsClosed).toBe(1);
  });

  it("closes the client when the sandbox can't be created", async () => {
    fake.createError = new Error("spend limit");

    await expect(modal().create({ env: {} })).rejects.toThrow("spend limit");
    expect(fake.clientsClosed).toBe(1);
  });

  it("close() terminates the sandbox and closes the client", async () => {
    const handle = await modal().create({ env: {} });
    await handle.close();

    expect(fake.terminated).toStrictEqual(["sb-1"]);
    expect(fake.clientsClosed).toBe(1);
  });
});

describe("modal() exec", () => {
  it("runs the command in sh -c, in the worktree unless cwd is given", async () => {
    const handle = await modal().create({ env: {} });
    await handle.exec("echo a && echo b");
    await handle.exec("pwd", { cwd: "/tmp" });

    expect(
      fake.execCalls.map(({ argv, workdir }) => ({ argv, workdir })),
    ).toStrictEqual([
      { argv: ["sh", "-c", "echo a && echo b"], workdir: "/workspace" },
      { argv: ["sh", "-c", "pwd"], workdir: "/tmp" },
    ]);
  });

  it("streams stdout lines across chunks, including a last line with no newline", async () => {
    fake.respond = () => ({
      stdout: ["one\ntw", "o\nthr", "ee"],
      stderr: "warn",
      exitCode: 3,
    });
    const handle = await modal().create({ env: {} });
    const lines: string[] = [];

    const result = await handle.exec("x", {
      onLine: (line) => {
        lines.push(line);
      },
    });

    expect(lines).toStrictEqual(["one", "two", "three"]);
    expect(result).toStrictEqual({
      stdout: "one\ntwo\nthree",
      stderr: "warn",
      exitCode: 3,
    });
  });

  it("returns the whole output without onLine", async () => {
    fake.respond = () => ({
      stdout: ["a\n", "b\n"],
      stderr: "e",
      exitCode: 1,
    });
    const handle = await modal().create({ env: {} });

    const result = await handle.exec("x");

    expect(result).toStrictEqual({
      stdout: "a\nb\n",
      stderr: "e",
      exitCode: 1,
    });
  });

  it("pipes stdin and closes it, and closes it with no stdin too", async () => {
    fake.respond = ({ stdin }) => ({ stdout: [stdin] });
    const handle = await modal().create({ env: {} });

    const withStdin = await handle.exec("cat", { stdin: "hello" });
    const without = await handle.exec("cat");

    expect(withStdin.stdout).toBe("hello");
    expect(without.stdout).toBe("");
  });
});

describe("modal() file copy", () => {
  it("copies a file and a nested directory in, and a file out", async () => {
    const host = await mkdtemp(path.join(tmpdir(), "modal-host-"));
    await writeFile(path.join(host, "bundle"), "b");
    await mkdir(path.join(host, "dir", "sub"), { recursive: true });
    await writeFile(path.join(host, "dir", "top.txt"), "t");
    await writeFile(path.join(host, "dir", "sub", "deep.txt"), "d");
    const handle = await modal().create({ env: {} });

    await handle.copyIn(path.join(host, "bundle"), "/tmp/bundle");
    await handle.copyIn(path.join(host, "dir"), "/workspace/dir");
    await handle.copyFileOut(
      "/workspace/dir/sub/deep.txt",
      path.join(host, "out", "deep.txt"),
    );

    await expect(
      readFile(path.join(fake.root, "tmp", "bundle"), "utf8"),
    ).resolves.toBe("b");
    await expect(
      readFile(path.join(fake.root, "workspace", "dir", "top.txt"), "utf8"),
    ).resolves.toBe("t");
    await expect(
      readFile(path.join(host, "out", "deep.txt"), "utf8"),
    ).resolves.toBe("d");
  });
});
