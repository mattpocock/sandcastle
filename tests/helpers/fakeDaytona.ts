import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A stand-in for `@daytona/sdk`, for `vi.mock`: just the calls daytona()
// makes, backed by real `sh` processes and a host directory per sandbox
// (`<root>/<id>/home` is its home and work dir), so the real session
// supervisor runs in it. Paths in the sandbox are host paths. Every call is
// recorded for the tests to assert on. POSIX only.

/** A command the fake ran, and how. */
export interface FakeCommand {
  readonly command: string;
  /** The session it ran in, or `undefined` for a plain `executeCommand`. */
  readonly sessionId: string | undefined;
}

interface Running {
  readonly child: ChildProcess;
  readonly out: { stream: "stdout" | "stderr"; chunk: string }[];
  readonly closed: Promise<number>;
}

interface FakeSdkSandbox {
  readonly id: string;
  state: string;
  readonly autoDestroyAt: string | undefined;
  readonly home: string;
  readonly sessions: Map<string, Map<string, Running>>;
}

/** What the fake records, and the failures a test can ask it for. */
export interface FakeDaytonaState {
  root: string;
  clientConfigs: unknown[];
  createCalls: Record<string, unknown>[];
  deleted: string[];
  uploads: { readonly path: string; readonly content: string }[];
  commands: FakeCommand[];
  sessionsDeleted: string[];
  sandboxes: Map<string, FakeSdkSandbox>;
  /** `autoDestroyAt` for the next sandbox: `"ttl"` computes it from `ttlMinutes`. */
  autoDestroyAt: string | undefined;
  createError: Error | undefined;
  createFolderError: Error | undefined;
}

const fresh = (root: string): FakeDaytonaState => ({
  root,
  clientConfigs: [],
  createCalls: [],
  deleted: [],
  uploads: [],
  commands: [],
  sessionsDeleted: [],
  sandboxes: new Map(),
  autoDestroyAt: "ttl",
  createError: undefined,
  createFolderError: undefined,
});

/** The fake's records, shared by the mocked module and the test. */
export const fakeDaytona: FakeDaytonaState = fresh("");

/** Forgets everything and makes a fresh temp dir for sandboxes, for `beforeEach`. */
export const resetFakeDaytona = async (): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-daytona-"));
  Object.assign(fakeDaytona, fresh(root));
};

const notFound = (what: string) =>
  Object.assign(new Error(`not found: ${what}`), { statusCode: 404 });

const killGroup = (running: Running): void => {
  try {
    if (running.child.pid !== undefined) {
      process.kill(-running.child.pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
};

const start = (sandbox: FakeSdkSandbox, command: string): Running => {
  const child = spawn("sh", ["-c", command], {
    cwd: sandbox.home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sandbox.home },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out: Running["out"] = [];
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    out.push({ stream: "stdout", chunk });
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    out.push({ stream: "stderr", chunk });
  });
  const closed = once(child, "close").then(([code]) =>
    typeof code === "number" ? code : 137,
  );
  return { child, out, closed };
};

const sessionOf = (sandbox: FakeSdkSandbox, sessionId: string) => {
  const session = sandbox.sessions.get(sessionId);
  if (session === undefined) {
    throw notFound(`session ${sessionId}`);
  }
  return session;
};

const commandOf = (
  sandbox: FakeSdkSandbox,
  sessionId: string,
  cmdId: string,
) => {
  const running = sessionOf(sandbox, sessionId).get(cmdId);
  if (running === undefined) {
    throw notFound(`command ${cmdId}`);
  }
  return running;
};

/** Streams a command's output, as it arrives, until it ends. */
const followLogs = async (
  running: Running,
  onStdout: (chunk: string) => void,
  onStderr: (chunk: string) => void,
): Promise<void> => {
  let sent = 0;
  const flush = () => {
    for (const { stream, chunk } of running.out.slice(sent)) {
      (stream === "stdout" ? onStdout : onStderr)(chunk);
    }
    sent = running.out.length;
  };
  const timer = setInterval(flush, 10);
  await running.closed;
  clearInterval(timer);
  flush();
};

const processApi = (sandbox: FakeSdkSandbox) => ({
  executeCommand: async (command: string) => {
    fakeDaytona.commands.push({ command, sessionId: undefined });
    const running = start(sandbox, command);
    const exitCode = await running.closed;
    return { exitCode, result: running.out.map((o) => o.chunk).join("") };
  },
  createSession: async (sessionId: string) => {
    sandbox.sessions.set(sessionId, new Map());
  },
  executeSessionCommand: async (
    sessionId: string,
    request: { readonly command: string },
  ) => {
    fakeDaytona.commands.push({ command: request.command, sessionId });
    const session = sessionOf(sandbox, sessionId);
    const cmdId = `cmd-${session.size + 1}`;
    session.set(cmdId, start(sandbox, request.command));
    return { cmdId };
  },
  // The SDK's own four-argument signature, taken as a tuple.
  getSessionCommandLogs: async (
    ...[sessionId, cmdId, onStdout, onStderr]: [
      string,
      string,
      (chunk: string) => void,
      (chunk: string) => void,
    ]
  ) => followLogs(commandOf(sandbox, sessionId, cmdId), onStdout, onStderr),
  getSessionCommand: async (sessionId: string, cmdId: string) => ({
    exitCode: await commandOf(sandbox, sessionId, cmdId).closed,
  }),
  deleteSession: async (sessionId: string) => {
    fakeDaytona.sessionsDeleted.push(sessionId);
    for (const running of sessionOf(sandbox, sessionId).values()) {
      killGroup(running);
    }
    sandbox.sessions.delete(sessionId);
  },
});

const fsApi = () => ({
  uploadFile: async (content: Buffer, remotePath: string) => {
    fakeDaytona.uploads.push({
      path: remotePath,
      content: content.toString("utf8"),
    });
    await mkdir(path.dirname(remotePath), { recursive: true });
    await writeFile(remotePath, content);
  },
  downloadFile: async (remotePath: string) =>
    readFile(remotePath).catch(() => {
      throw notFound(remotePath);
    }),
  createFolder: async (remotePath: string) => {
    if (fakeDaytona.createFolderError !== undefined) {
      throw fakeDaytona.createFolderError;
    }
    await mkdir(remotePath, { recursive: true });
  },
});

/** The SDK's view of a fake sandbox. */
const sdkSandbox = (sandbox: FakeSdkSandbox) => ({
  get id() {
    return sandbox.id;
  },
  get state() {
    return sandbox.state;
  },
  autoDestroyAt: sandbox.autoDestroyAt,
  getWorkDir: async () => sandbox.home,
  getUserHomeDir: async () => sandbox.home,
  process: processApi(sandbox),
  fs: fsApi(),
});

const destroy = async (sandbox: FakeSdkSandbox): Promise<void> => {
  sandbox.state = "destroyed";
  for (const session of sandbox.sessions.values()) {
    for (const running of session.values()) {
      killGroup(running);
    }
  }
  await rm(path.dirname(sandbox.home), { recursive: true, force: true });
};

const killTimeFor = (params: Record<string, unknown>): string | undefined => {
  if (fakeDaytona.autoDestroyAt !== "ttl") {
    return fakeDaytona.autoDestroyAt;
  }
  const minutes = typeof params.ttlMinutes === "number" ? params.ttlMinutes : 0;
  return new Date(Date.now() + minutes * 60_000).toISOString();
};

/** What `new Daytona(config)` gives. */
export const fakeDaytonaClient = (config: unknown) => {
  fakeDaytona.clientConfigs.push(config);
  return {
    create: async (params: Record<string, unknown> = {}) => {
      fakeDaytona.createCalls.push(params);
      if (fakeDaytona.createError !== undefined) {
        throw fakeDaytona.createError;
      }
      const id = `dtn-${fakeDaytona.createCalls.length}`;
      const home = path.join(fakeDaytona.root, id, "home");
      await mkdir(home, { recursive: true });
      const sandbox: FakeSdkSandbox = {
        id,
        state: "started",
        autoDestroyAt: killTimeFor(params),
        home,
        sessions: new Map(),
      };
      fakeDaytona.sandboxes.set(id, sandbox);
      return sdkSandbox(sandbox);
    },
    get: async (id: string) => {
      const sandbox = fakeDaytona.sandboxes.get(id);
      if (sandbox === undefined || sandbox.state === "destroyed") {
        throw notFound(`sandbox ${id}`);
      }
      return sdkSandbox(sandbox);
    },
    delete: async (sandbox: { readonly id: string }) => {
      const made = fakeDaytona.sandboxes.get(sandbox.id);
      if (made === undefined || made.state === "destroyed") {
        throw notFound(`sandbox ${sandbox.id}`);
      }
      fakeDaytona.deleted.push(sandbox.id);
      await destroy(made);
    },
  };
};

/** Ends every fake sandbox still standing and removes the temp dir, for `afterEach`. */
export const destroyAllFakeDaytona = async (): Promise<void> => {
  await Promise.all(
    [...fakeDaytona.sandboxes.values()].map(async (sandbox) =>
      destroy(sandbox),
    ),
  );
  await rm(fakeDaytona.root, { recursive: true, force: true });
};

/** Adds a sandbox the fake API knows about, as if made before a create failed. */
export const orphanFakeDaytona = async (id: string): Promise<void> => {
  const home = path.join(fakeDaytona.root, id, "home");
  await mkdir(home, { recursive: true });
  fakeDaytona.sandboxes.set(id, {
    id,
    state: "started",
    autoDestroyAt: undefined,
    home,
    sessions: new Map(),
  });
};
