import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { killProcessTrees } from "./processTree.js";

// A stand-in for `@vercel/sandbox`, for `vi.mock`: just the `Sandbox` calls
// vercel() makes, backed by real `sh` processes and a host directory per
// sandbox (`<root>/<name>` is its session directory, `cwd`), so the real
// session supervisor runs in it. Paths in the sandbox are host paths. As on
// Vercel, a command it waits for gets no stdin, the streams it writes to are
// never ended, and a kill signals only the command's own process. Every
// call is recorded for the tests to assert on. POSIX only.

/** A `runCommand` call the fake got, without its streams. */
export interface FakeVercelCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly sudo: boolean;
  readonly detached: boolean;
  readonly timeoutMs: number | undefined;
}

interface FakeSdkSandbox {
  readonly name: string;
  status: string;
  expiresAt: Date | undefined;
  readonly cwd: string;
  readonly running: Set<ChildProcess>;
}

/** What the fake records, and the failures a test can ask it for. */
export interface FakeVercelState {
  root: string;
  createCalls: Record<string, unknown>[];
  getCalls: Record<string, unknown>[];
  stopped: string[];
  commands: FakeVercelCommand[];
  writes: { readonly path: string; readonly content: string }[];
  sandboxes: Map<string, FakeSdkSandbox>;
  /** `expiresAt` for the next sandbox: `"timeout"` computes it from `timeout`. */
  expiresAt: Date | "timeout" | undefined;
  createError: Error | undefined;
  /** Called once `create` has made its sandbox, before it resolves. */
  afterCreate: (() => void) | undefined;
  /** While set, a `mkdir` command fails, as on a read-only disk. */
  mkdirFails: boolean;
}

const fresh = (root: string): FakeVercelState => ({
  root,
  createCalls: [],
  getCalls: [],
  stopped: [],
  commands: [],
  writes: [],
  sandboxes: new Map(),
  expiresAt: "timeout",
  createError: undefined,
  afterCreate: undefined,
  mkdirFails: false,
});

/** The fake's records, shared by the mocked module and the test. */
export const fakeVercel: FakeVercelState = fresh("");

/** Forgets everything and makes a fresh temp dir for sandboxes, for `beforeEach`. */
export const resetFakeVercel = async (): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-vercel-"));
  Object.assign(fakeVercel, fresh(root));
};

/** An error shaped like the SDK's `APIError`. */
const apiError = (status: number, message: string) =>
  Object.assign(new Error(message), { response: { status } });

/** A process's exit code, as a shell reports one killed by a signal. */
const exitCodeOf = (code: unknown, signal: unknown): number => {
  if (typeof code === "number") {
    return code;
  }
  return signal === "SIGTERM" ? 143 : 137;
};

interface RunCommandParams {
  readonly cmd: string;
  readonly args?: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly sudo?: boolean;
  readonly detached?: boolean;
  readonly timeoutMs?: number;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly onStart?: (command: unknown) => void | Promise<void>;
}

const runCommand = async (
  sandbox: FakeSdkSandbox,
  params: RunCommandParams,
) => {
  fakeVercel.commands.push({
    cmd: params.cmd,
    args: params.args ?? [],
    cwd: params.cwd,
    env: params.env ?? {},
    sudo: params.sudo === true,
    detached: params.detached === true,
    timeoutMs: params.timeoutMs,
  });
  if (sandbox.status !== "running") {
    throw apiError(410, `sandbox ${sandbox.name} is ${sandbox.status}`);
  }
  const [cmd, args] =
    fakeVercel.mkdirFails && (params.args ?? []).join(" ").includes("mkdir")
      ? ["sh", ["-c", "echo read-only file system >&2; exit 1"]]
      : [params.cmd, params.args ?? []];
  const child = spawn(cmd, args, {
    cwd: params.cwd ?? sandbox.cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sandbox.cwd,
      ...params.env,
    },
    // Its own process group, so stop() can end everything it started.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  sandbox.running.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    params.stdout?.write(chunk);
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    params.stderr?.write(chunk);
  });
  const closed = once(child, "close").then(([code, signal]) => {
    sandbox.running.delete(child);
    return exitCodeOf(code, signal);
  });
  const command = {
    cmdId: `cmd-${fakeVercel.commands.length}`,
    // Vercel signals the command's own process, not what it started.
    kill: async () => {
      child.kill("SIGTERM");
    },
  };
  if (params.detached === true) {
    return command;
  }
  await params.onStart?.(command);
  const exitCode = await closed;
  return {
    ...command,
    exitCode,
    stdout: async () => stdout,
    stderr: async () => stderr,
  };
};

/** The SDK's view of a fake sandbox: reads its state as it is now. */
const sdkSandbox = (sandbox: FakeSdkSandbox) => ({
  get name() {
    return sandbox.name;
  },
  get status() {
    return sandbox.status;
  },
  // Read once, as the real SDK caches it on the object.
  expiresAt: sandbox.expiresAt,
  get cwd() {
    return sandbox.cwd;
  },
  runCommand: async (params: RunCommandParams) => runCommand(sandbox, params),
  writeFiles: async (
    files: readonly { readonly path: string; readonly content: Uint8Array }[],
  ) => {
    await Promise.all(
      files.map(async (file) => {
        const content = Buffer.from(file.content).toString("utf8");
        fakeVercel.writes.push({ path: file.path, content });
        await mkdir(path.dirname(file.path), { recursive: true });
        await writeFile(file.path, content);
      }),
    );
  },
  readFileToBuffer: async ({ path: file }: { readonly path: string }) =>
    readFile(file).catch(() => null),
  stop: async () => {
    if (sandbox.status !== "stopped") {
      fakeVercel.stopped.push(sandbox.name);
    }
    sandbox.status = "stopped";
    sandbox.expiresAt = undefined;
    killProcessTrees([...sandbox.running].map((child) => child.pid));
    return {};
  },
});

const expiresAtFor = (params: Record<string, unknown>): Date | undefined => {
  if (fakeVercel.expiresAt !== "timeout") {
    return fakeVercel.expiresAt;
  }
  const timeout = typeof params.timeout === "number" ? params.timeout : 0;
  return new Date(Date.now() + timeout);
};

/** The fake `Sandbox` class: `Sandbox.create` and `Sandbox.get`. */
export const FakeVercelSandbox = {
  create: async (params: Record<string, unknown> = {}) => {
    fakeVercel.createCalls.push(params);
    if (fakeVercel.createError !== undefined) {
      throw fakeVercel.createError;
    }
    const name = `sbx-${fakeVercel.createCalls.length}`;
    const cwd = path.join(fakeVercel.root, name);
    await mkdir(cwd, { recursive: true });
    const sandbox: FakeSdkSandbox = {
      name,
      status: "running",
      expiresAt: expiresAtFor(params),
      cwd,
      running: new Set(),
    };
    fakeVercel.sandboxes.set(name, sandbox);
    fakeVercel.afterCreate?.();
    return sdkSandbox(sandbox);
  },
  get: async (params: Record<string, unknown>) => {
    fakeVercel.getCalls.push(params);
    const sandbox = fakeVercel.sandboxes.get(String(params.name));
    if (sandbox === undefined) {
      throw apiError(404, `Named sandbox '${String(params.name)}' not found`);
    }
    return sdkSandbox(sandbox);
  },
};

/** Sets when a fake sandbox will stop, as another handle extending its timeout would. */
export const extendFakeVercel = (name: string, expiresAt: Date): void => {
  const sandbox = fakeVercel.sandboxes.get(name);
  if (sandbox === undefined) {
    throw new Error(`no fake sandbox ${name}`);
  }
  sandbox.expiresAt = expiresAt;
};

/** Stops every fake sandbox still standing and removes the temp dir, for `afterEach`. */
export const destroyAllFakeVercel = async (): Promise<void> => {
  killProcessTrees(
    [...fakeVercel.sandboxes.values()].flatMap((sandbox) =>
      [...sandbox.running].map((child) => child.pid),
    ),
  );
  await rm(fakeVercel.root, { recursive: true, force: true });
};
