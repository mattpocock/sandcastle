import { spawn } from "node:child_process";
import { once } from "node:events";
import { open } from "node:fs/promises";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { Either } from "effect";
import type { ProviderExecResult } from "../SandboxProvider.js";
import type { KeeperReply, KeeperRequest } from "./localKeeperProtocol.js";
import {
  collect,
  decodeKeeperReply,
  emptyOutput,
  encodeKeeperLine,
  KEEPER_READY,
  lineSplitter,
} from "./localKeeperProtocol.js";
import { keeperProgram } from "./localKeeperProgram.js";
import type { LocalSandboxFolder } from "./localSandboxState.js";
import {
  keeperLog,
  keeperSocket,
  removeSandboxFolder,
} from "./localSandboxState.js";

// The host's side of a local sandbox's keeper (localKeeperMain.ts): start
// it, and ask it to run, start or close. Provider-agnostic: a provider hands
// it the whole argv and env of each command.

/** How long a new keeper has to start listening. */
const START_TIMEOUT_MS = 30_000;
/** The exit code of a command killed through its abort signal (SIGTERM's). */
const ABORTED_EXIT_CODE = 143;

/** A command for the keeper to run: the whole argv, and exactly its env. */
export interface KeeperCommand {
  readonly argv: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
  /** Kill its process group as it exits, where there's no PID namespace to. */
  readonly endGroupOnExit?: boolean;
}

/** The longest Unix socket path, in bytes, with its NUL: macOS's is the shorter. */
const SOCKET_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;

/** A command as the keeper's request carries it. */
const requestOf = ({ argv, env, endGroupOnExit }: KeeperCommand) => ({
  argv,
  env,
  ...(endGroupOnExit === true ? { endGroupOnExit } : {}),
});

const keeperFailed = (detail: string): Error =>
  new Error(`the sandbox's keeper ${detail}`);

/** Throws when the keeper's socket path is too long for this OS to listen at. */
const assertSocketFits = (folder: LocalSandboxFolder): void => {
  const socket = keeperSocket(folder);
  if (Buffer.byteLength(socket) >= SOCKET_PATH_LIMIT) {
    throw keeperFailed(
      `can't listen at ${socket}: the path is longer than this OS allows a socket's. Set XDG_STATE_HOME to a shorter folder.`,
    );
  }
};

/**
 * Starts the keeper of the sandbox in `folder`, detached in its own session
 * so it outlives this process, and resolves once it's listening.
 */
export const startKeeper = async (
  folder: LocalSandboxFolder,
): Promise<void> => {
  assertSocketFits(folder);
  const log = await open(keeperLog(folder), "a", 0o600);
  const keeper = spawn(process.execPath, [await keeperProgram(), folder.path], {
    detached: true,
    // Not the caller's folder: the keeper's commands start where it runs,
    // and a sandbox that can't see that folder fails to start a shell in it.
    cwd: "/",
    // None of the host's env: the keeper needs none, and passes none on.
    env: {},
    stdio: ["ignore", "pipe", log.fd],
  });
  await log.close();
  const { stdout } = keeper;
  if (stdout === null) {
    keeper.kill("SIGKILL");
    throw keeperFailed("started with no stdout");
  }
  const lines = createInterface({ input: stdout });
  const ready = once(lines, "line").then(([line]: unknown[]) => {
    if (line !== KEEPER_READY) {
      throw keeperFailed(`said ${String(line)} instead of ${KEEPER_READY}`);
    }
    return line;
  });
  const exited = once(keeper, "exit").then(([code]: unknown[]) => {
    throw keeperFailed(
      `exited (${String(code)}) before it was ready; see ${keeperLog(folder)}`,
    );
  });
  const timer = AbortSignal.timeout(START_TIMEOUT_MS);
  const timedOut = once(timer, "abort").then(() => {
    throw keeperFailed(`didn't start within ${START_TIMEOUT_MS / 1000}s`);
  });
  try {
    await Promise.race([ready, exited, timedOut]);
  } catch (error) {
    keeper.kill("SIGKILL");
    throw error;
  } finally {
    lines.close();
    stdout.destroy();
    keeper.unref();
  }
};

/** A connection to the keeper, or `undefined` when it isn't listening. */
const connectTo = async (
  folder: LocalSandboxFolder,
): Promise<Socket | undefined> => {
  const socket = connect(keeperSocket(folder));
  // `once` rejects on an "error" event: a refused or missing socket.
  return once(socket, "connect").then(
    () => socket,
    () => undefined,
  );
};

/**
 * Sends one request and hands each reply to `onReply`. Resolves `false`
 * when the keeper isn't there, else `true` once it ends the connection.
 */
const ask = async (
  folder: LocalSandboxFolder,
  request: KeeperRequest,
  {
    onReply,
    abortSignal,
  }: {
    readonly onReply: (reply: KeeperReply) => void;
    readonly abortSignal?: AbortSignal | undefined;
  },
): Promise<boolean> => {
  const socket = await connectTo(folder);
  if (socket === undefined) {
    return false;
  }
  const abort = (): void => {
    socket.destroy();
  };
  abortSignal?.addEventListener("abort", abort, { once: true });
  socket.on("error", () => undefined);
  const closed = once(socket, "close");
  socket.write(encodeKeeperLine(request));
  for await (const line of createInterface({ input: socket })) {
    const reply = decodeKeeperReply(line);
    if (Either.isRight(reply)) {
      onReply(reply.right);
    }
  }
  await closed;
  abortSignal?.removeEventListener("abort", abort);
  return true;
};

/** Whether the keeper is there, answering. */
export const keeperAlive = async (
  folder: LocalSandboxFolder,
): Promise<boolean> => {
  let answered = false;
  await ask(
    folder,
    { type: "ping" },
    {
      onReply: (reply) => {
        answered = reply.type === "pong";
      },
    },
  );
  return answered;
};

const ended = (folder: LocalSandboxFolder): Error =>
  new Error(
    `sandbox ${folder.sandboxId} has ended: it was closed, or reached its kill time`,
  );

/** Has the keeper run a command, streaming its stdout to `onLine` line by line. */
export const keeperExec = async (
  folder: LocalSandboxFolder,
  command: KeeperCommand & {
    readonly stdin: string;
    readonly onLine?: (line: string) => void;
    readonly abortSignal?: AbortSignal;
  },
): Promise<ProviderExecResult> => {
  const output = emptyOutput();
  const lines = lineSplitter(command.onLine);
  const { stdin, abortSignal } = command;
  const reached = await ask(
    folder,
    { type: "exec", ...requestOf(command), stdin },
    {
      onReply: (reply) => {
        collect(output, lines, reply);
      },
      abortSignal,
    },
  );
  lines.end();
  if (!reached) {
    throw ended(folder);
  }
  if (output.exitCode === undefined && abortSignal?.aborted !== true) {
    throw ended(folder);
  }
  return {
    exitCode: output.exitCode ?? ABORTED_EXIT_CODE,
    stdout: output.stdout,
    stderr: output.stderr,
  };
};

/** Has the keeper start a command it alone owns, resolving once it's running. */
export const keeperSpawn = async (
  folder: LocalSandboxFolder,
  command: KeeperCommand,
): Promise<void> => {
  let outcome: KeeperReply | undefined;
  const reached = await ask(
    folder,
    { type: "spawn", ...requestOf(command) },
    {
      onReply: (reply) => {
        outcome = reply;
      },
    },
  );
  if (!reached) {
    throw ended(folder);
  }
  if (outcome?.type !== "spawned") {
    throw keeperFailed(
      `couldn't start the command: ${outcome?.type === "error" ? outcome.message : "no answer"}`,
    );
  }
};

/**
 * Has the keeper kill everything in the sandbox and remove its folder.
 * Where the keeper is gone already (killed, or the machine restarted), the
 * folder is removed here. Safe to call twice.
 */
export const closeKeeper = async (
  folder: LocalSandboxFolder,
): Promise<void> => {
  let closed = false;
  await ask(
    folder,
    { type: "close" },
    {
      onReply: (reply) => {
        closed = reply.type === "closed";
      },
    },
  );
  if (!closed) {
    await removeSandboxFolder(folder.path);
  }
};
