import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { Either } from "effect";
import type { KeeperReply, KeeperRequest } from "./localKeeperProtocol.js";
import {
  decodeKeeperRequest,
  encodeKeeperLine,
} from "./localKeeperProtocol.js";
import { killGroup, killProcessTree } from "./localProcessTree.js";

// The keeper's side of its socket: it runs each command it's asked to as its
// own child, so it can kill every one of them at the kill time or on close,
// whoever asked. Each child gets its own process group, and a lifeline on
// LIFELINE_FD whose other end only the keeper holds: the child reads
// end-of-file once the keeper closes it or dies, however it dies, and a
// provider's argv can watch that fd to end its sandbox. Every kill is by
// process group, never `kill -1`: with no PID namespace (seatbelt() on
// macOS), that's every process the user has.

/** The fd each child's lifeline is on. */
export const LIFELINE_FD = 4;
/** How long a kill waits for children to exit before the folder goes anyway. */
const EXIT_WAIT_MS = 5000;

/** What a connection's handler needs from the keeper. */
export interface KeeperContext {
  readonly children: Set<ChildProcess>;
  /** Kills everything and removes the folder, once; later calls get the same promise. */
  readonly shutdown: () => Promise<void>;
}

/**
 * SIGKILLs a child's process group, and those of every process below it,
 * and closes its lifeline. The tree is walked first: once the child is
 * killed, what it started is no longer below it.
 */
export const killChild = async (child: ChildProcess): Promise<void> => {
  if (child.pid !== undefined) {
    await killProcessTree([child.pid]);
  }
  child.stdio[LIFELINE_FD]?.destroy();
  killGroup(child.pid);
};

/** Kills every child and all they started, waiting (a while) for each to exit. */
export const killChildren = async (
  children: ReadonlySet<ChildProcess>,
): Promise<void> => {
  const running = [...children];
  const exits = running.map(async (child) =>
    child.exitCode === null && child.signalCode === null
      ? once(child, "close").then(() => undefined)
      : undefined,
  );
  // Everything below the keeper, even what a command moved out of its
  // child's group (a detached spawn), while it's still in the tree.
  await killProcessTree([process.pid]);
  await Promise.all(running.map(async (child) => killChild(child)));
  await Promise.race([Promise.allSettled(exits), sleep(EXIT_WAIT_MS)]);
};

const send = (socket: Socket, reply: KeeperReply): void => {
  if (!socket.destroyed) {
    socket.write(encodeKeeperLine(reply));
  }
};

/** Starts a child the keeper owns, tracked until it exits. */
const startChild = (
  context: KeeperContext,
  request: {
    readonly argv: readonly string[];
    readonly env: object;
    readonly endGroupOnExit?: boolean | undefined;
  },
  stdio: "pipe" | "ignore",
): ChildProcess => {
  const [file = "", ...args] = request.argv;
  const child = spawn(file, args, {
    env: { ...request.env },
    detached: true,
    stdio: [stdio, stdio, stdio, "ignore", "pipe"],
  });
  context.children.add(child);
  const forget = (): void => {
    context.children.delete(child);
  };
  child.once("close", forget);
  child.on("error", forget);
  if (request.endGroupOnExit === true) {
    // Nothing it started outlives it, as with a PID namespace: its group
    // is killed as it exits.
    child.once("exit", () => {
      killGroup(child.pid);
    });
  }
  child.stdio[LIFELINE_FD]?.on("error", () => undefined);
  return child;
};

const runExec = (
  context: KeeperContext,
  request: Extract<KeeperRequest, { type: "exec" }>,
  socket: Socket,
): void => {
  const child = startChild(context, request, "pipe");
  socket.once("close", () => {
    if (child.exitCode === null && child.signalCode === null) {
      void killChild(child);
    }
  });
  child.on("error", (error) => {
    send(socket, { type: "error", message: error.message });
    socket.end();
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (data: string) => {
    send(socket, { type: "stdout", data });
  });
  child.stderr?.on("data", (data: string) => {
    send(socket, { type: "stderr", data });
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(request.stdin);
  child.once("close", (code, signal) => {
    // A command killed by a signal exits as a shell reports it: 128 + its number.
    const killed = signal === null ? 1 : 128 + 9;
    send(socket, { type: "exit", code: code ?? killed });
    socket.end();
  });
};

const runSpawn = (
  context: KeeperContext,
  request: Extract<KeeperRequest, { type: "spawn" }>,
  socket: Socket,
): void => {
  const child = startChild(context, request, "ignore");
  child.once("spawn", () => {
    send(socket, { type: "spawned" });
    socket.end();
  });
  child.once("error", (error) => {
    send(socket, { type: "error", message: error.message });
    socket.end();
  });
};

const handle = (
  context: KeeperContext,
  request: KeeperRequest,
  socket: Socket,
): void => {
  switch (request.type) {
    case "ping": {
      send(socket, { type: "pong" });
      socket.end();
      return;
    }
    case "exec": {
      runExec(context, request, socket);
      return;
    }
    case "spawn": {
      runSpawn(context, request, socket);
      return;
    }
    case "close": {
      void context.shutdown().finally(() => {
        send(socket, { type: "closed" });
        socket.end();
      });
    }
  }
};

/** Reads one request from each connection and answers it. */
export const onKeeperConnection =
  (context: KeeperContext) =>
  (socket: Socket): void => {
    socket.on("error", () => undefined);
    const lines = createInterface({ input: socket });
    lines.once("line", (line) => {
      lines.close();
      const request = decodeKeeperRequest(line);
      if (Either.isLeft(request)) {
        send(socket, { type: "error", message: "unreadable request" });
        socket.end();
        return;
      }
      handle(context, request.right, socket);
    });
  };
