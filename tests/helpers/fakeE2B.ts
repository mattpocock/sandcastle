import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CommandExitError,
  FileNotFoundError,
  Sandbox,
  SandboxNotFoundError,
} from "e2b";
import { killProcessTrees } from "./processTree.js";

// A stand-in for `e2b`'s `Sandbox`, for `vi.mock`: just the calls e2b()
// makes, backed by real `sh` processes and a host directory per sandbox
// (`<root>/<id>/home` is its HOME), so the real session supervisor runs in
// it. Paths in the sandbox are host paths. The fake keeps a kill time per
// sandbox the way E2B does: set from `timeoutMs` at create, and only ever
// lengthened by a connect, which falls back to E2B's default of 5 minutes
// when it isn't given one. Every call is recorded for the tests to assert
// on. POSIX only.

/** A command the fake ran, and how. */
export interface FakeE2BCommand {
  readonly command: string;
  readonly options: RunOptions;
}

interface FakeSdkSandbox {
  readonly id: string;
  killed: boolean;
  endAt: Date;
  readonly home: string;
  readonly running: Set<ChildProcess>;
}

/** What the fake records, and the failures a test can ask it for. */
export interface FakeE2BState {
  root: string;
  createCalls: Record<string, unknown>[];
  /** Each connect, and how far it moved the sandbox's kill time. */
  connectCalls: {
    readonly sandboxId: string;
    readonly apiKey: string | undefined;
    readonly endAtMovedMs: number;
  }[];
  getInfoCalls: { readonly sandboxId: string; readonly options: unknown }[];
  killed: string[];
  commands: FakeE2BCommand[];
  /** Commands whose stream the host disconnected from. */
  disconnected: string[];
  sandboxes: Map<string, FakeSdkSandbox>;
  /** The longest a sandbox may live, as an E2B plan caps it. */
  planCapMs: number;
  createError: Error | undefined;
  /** Thrown by the sandbox's `getInfo`, while set. */
  getInfoError: Error | undefined;
  /** Commands matching it exit 1 without running, while set. */
  failCommand: RegExp | undefined;
}

/** What the fake takes from the real `e2b`: its class to extend, and its errors. */
export interface E2BModule {
  readonly Sandbox: typeof Sandbox;
  readonly CommandExitError: typeof CommandExitError;
  readonly FileNotFoundError: typeof FileNotFoundError;
  readonly SandboxNotFoundError: typeof SandboxNotFoundError;
}

let sdk: E2BModule | undefined;

/** The real SDK's errors, once the mocked module has handed them over. */
const errors = (): E2BModule => {
  if (sdk === undefined) {
    throw new Error("fakeSandboxClass() has not been called");
  }
  return sdk;
};

/** E2B's default timeout for a connect that doesn't give one. */
const CONNECT_DEFAULT_TIMEOUT_MS = 300_000;

const fresh = (root: string): FakeE2BState => ({
  root,
  createCalls: [],
  connectCalls: [],
  getInfoCalls: [],
  killed: [],
  commands: [],
  disconnected: [],
  sandboxes: new Map(),
  planCapMs: 24 * 60 * 60_000,
  createError: undefined,
  getInfoError: undefined,
  failCommand: undefined,
});

/** The fake's records, shared by the mocked module and the test. */
export const fakeE2B: FakeE2BState = fresh("");

/** Forgets everything and makes a fresh temp dir for sandboxes, for `beforeEach`. */
export const resetFakeE2B = async (): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-e2b-"));
  Object.assign(fakeE2B, fresh(root));
};

const killGroup = (child: ChildProcess): void => {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
};

const destroy = async (sandbox: FakeSdkSandbox): Promise<void> => {
  sandbox.killed = true;
  killProcessTrees([...sandbox.running].map((child) => child.pid));
  await rm(path.dirname(sandbox.home), { recursive: true, force: true });
};

/** The options of `commands.run` the fake looks at, or the tests do. */
export interface RunOptions {
  readonly background?: boolean;
  readonly timeoutMs?: number;
  readonly user?: string;
  readonly cwd?: string;
  readonly envs?: Readonly<Record<string, string>>;
  readonly stdin?: boolean;
  readonly onStdout?: (data: string) => void;
  readonly onStderr?: (data: string) => void;
}

/** What envd answers for a process that has exited: a not-found error. */
const processGone = (): Error =>
  Object.assign(new Error("process not found"), { name: "NotFoundError" });

/** Starts `command` in `sh`, in its own process group, streaming its output as it arrives. */
const start = (
  sandbox: FakeSdkSandbox,
  command: string,
  options: RunOptions,
) => {
  const failed = fakeE2B.failCommand?.test(command) === true;
  const child = spawn("sh", ["-c", failed ? "exit 1" : command], {
    cwd: options.cwd ?? sandbox.home,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sandbox.home,
      ...options.envs,
    },
    detached: true,
    stdio: [options.stdin === true ? "pipe" : "ignore", "pipe", "pipe"],
  });
  sandbox.running.add(child);
  let connected = true;
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (connected) {
      options.onStdout?.(chunk);
    }
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    if (connected) {
      options.onStderr?.(chunk);
    }
  });
  const closed = once(child, "close").then(([code]) => {
    sandbox.running.delete(child);
    return typeof code === "number" ? code : 137;
  });
  const wait = async () => {
    const exitCode = await closed;
    const result = { exitCode, stdout, stderr, error: undefined };
    if (exitCode !== 0) {
      throw new (errors().CommandExitError)({
        ...result,
        error: `exit ${exitCode}`,
      });
    }
    return result;
  };
  const stdinOf = () => {
    if (child.stdin === null) {
      throw new Error("the command was started without stdin");
    }
    return child.stdin;
  };
  return {
    pid: child.pid ?? 0,
    wait,
    sendStdin: async (data: string) => {
      if (child.exitCode !== null) {
        throw processGone();
      }
      stdinOf().write(data);
    },
    closeStdin: async () => {
      if (child.exitCode !== null) {
        throw processGone();
      }
      stdinOf().end();
    },
    kill: async () => {
      killGroup(child);
      return true;
    },
    disconnect: async () => {
      connected = false;
      fakeE2B.disconnected.push(command);
    },
  };
};

const live = (id: string): FakeSdkSandbox => {
  const sandbox = fakeE2B.sandboxes.get(id);
  if (sandbox === undefined || sandbox.killed) {
    throw new (errors().SandboxNotFoundError)(`sandbox ${id} not found`);
  }
  return sandbox;
};

const infoOf = (sandbox: FakeSdkSandbox) => ({
  sandboxId: sandbox.id,
  endAt: sandbox.endAt,
  state: "running",
});

/** The SDK's view of a fake sandbox. */
const sdkSandbox = (sandbox: FakeSdkSandbox) => ({
  sandboxId: sandbox.id,
  commands: {
    run: async (command: string, options: RunOptions = {}) => {
      live(sandbox.id);
      fakeE2B.commands.push({ command, options });
      const handle = start(sandbox, command, options);
      return options.background === true ? handle : handle.wait();
    },
  },
  files: {
    read: async (remotePath: string) =>
      readFile(remotePath, "utf8").catch(() => {
        throw new (errors().FileNotFoundError)(`file ${remotePath} not found`);
      }),
    write: async (remotePath: string, content: string) => {
      await mkdir(path.dirname(remotePath), { recursive: true });
      await writeFile(remotePath, content);
      return { path: remotePath };
    },
  },
  getInfo: async () => {
    if (fakeE2B.getInfoError !== undefined) {
      throw fakeE2B.getInfoError;
    }
    return infoOf(live(sandbox.id));
  },
  kill: async () => {
    if (sandbox.killed) {
      return false;
    }
    fakeE2B.killed.push(sandbox.id);
    await destroy(sandbox);
    return true;
  },
});

/** `Sandbox.create`. */
export const fakeCreate = async (options: Record<string, unknown> = {}) => {
  fakeE2B.createCalls.push(options);
  if (fakeE2B.createError !== undefined) {
    throw fakeE2B.createError;
  }
  const id = `e2b-${fakeE2B.createCalls.length}`;
  const home = path.join(fakeE2B.root, id, "home");
  await mkdir(home, { recursive: true });
  const timeoutMs =
    typeof options.timeoutMs === "number" ? options.timeoutMs : 300_000;
  const sandbox: FakeSdkSandbox = {
    id,
    killed: false,
    endAt: new Date(Date.now() + Math.min(timeoutMs, fakeE2B.planCapMs)),
    home,
    running: new Set(),
  };
  fakeE2B.sandboxes.set(id, sandbox);
  return sdkSandbox(sandbox);
};

/** `Sandbox.connect`: lengthens the sandbox's timeout, never shortens it. */
export const fakeConnect = async (
  sandboxId: string,
  options: { readonly apiKey?: string; readonly timeoutMs?: number } = {},
) => {
  const sandbox = live(sandboxId);
  const before = sandbox.endAt;
  const asked = new Date(
    Date.now() + (options.timeoutMs ?? CONNECT_DEFAULT_TIMEOUT_MS),
  );
  if (asked > sandbox.endAt) {
    sandbox.endAt = asked;
  }
  fakeE2B.connectCalls.push({
    sandboxId,
    apiKey: options.apiKey,
    endAtMovedMs: sandbox.endAt.getTime() - before.getTime(),
  });
  return sdkSandbox(sandbox);
};

/** `Sandbox.getInfo`. */
export const fakeGetInfo = async (sandboxId: string, options?: unknown) => {
  fakeE2B.getInfoCalls.push({ sandboxId, options });
  return infoOf(live(sandboxId));
};

/**
 * `e2b`'s real `Sandbox` class, with the static calls e2b() makes swapped
 * for the fake's: what the mocked module exports as `Sandbox`.
 */
export const fakeSandboxClass = (actual: E2BModule): typeof Sandbox => {
  sdk = actual;
  class FakeSandbox extends actual.Sandbox {}
  return Object.assign(FakeSandbox, {
    create: fakeCreate,
    connect: fakeConnect,
    getInfo: fakeGetInfo,
  });
};

/** Kills every fake sandbox still standing and removes the temp dir, for `afterEach`. */
export const destroyAllFakeE2B = async (): Promise<void> => {
  await Promise.all(
    [...fakeE2B.sandboxes.values()].map(async (sandbox) => destroy(sandbox)),
  );
  await rm(fakeE2B.root, { recursive: true, force: true });
};
