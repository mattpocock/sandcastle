import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { Either, Schema } from "effect";
import type { SealingKeys } from "./sealedSecret.js";
import { makeSealingKeys, openSecret } from "./sealedSecret.js";
import type { RecordSecrets } from "./sessionRecordSchema.js";
import { RecordSecretsJson } from "./sessionRecordSchema.js";
import type {
  DetachRequest,
  Reply,
  Request,
  SessionRequest,
} from "./supervisorProtocol.js";
import { RequestJson } from "./supervisorProtocol.js";
import { SessionRegistry } from "./supervisorRegistry.js";
import { StatusBoard } from "./supervisorStatus.js";

// The session supervisor's long-running half. It runs in its own directory
// inside the sandbox and listens on a Unix socket there (a relative path, so
// a deep sandbox home can't push it past the socket path limit). Each
// connection carries one request from the host's short-lived client and the
// replies to it.

/** The supervisor's socket, relative to its directory. */
export const SOCKET = "control.sock";

const decodeRequest = Schema.decodeUnknownEither(RequestJson);
const decodeSecrets = Schema.decodeUnknownEither(RecordSecretsJson);

/** Writes one reply line; a client that has gone away is fine. */
const sender =
  (socket: Socket) =>
  (reply: Reply): void => {
    if (socket.writable) {
      socket.write(`${JSON.stringify(reply)}\n`);
    }
  };

/** Replies `ok` once `done` settles, and ends the connection. */
const answer = async (socket: Socket, done: Promise<void>): Promise<void> => {
  await done;
  sender(socket)({ type: "ok" });
  socket.end();
};

/** Sends the one reply `reply` resolves with, and ends the connection. */
const replyOnce = async (
  socket: Socket,
  reply: Promise<Reply>,
): Promise<void> => {
  sender(socket)(await reply);
  socket.end();
};

interface Context {
  readonly registry: SessionRegistry;
  readonly server: Server;
  readonly keys: SealingKeys;
}

/** Carries the running sessions on; the supervisor stops once they're reported. */
const detach = async (
  request: DetachRequest,
  send: (reply: Reply) => void,
  context: Context,
): Promise<void> => {
  const sealed = request.finishReport?.sealedSecret;
  const secret =
    sealed === undefined
      ? undefined
      : openSecret(context.keys.privateKey, sealed);
  if (sealed !== undefined && secret === undefined) {
    send({ type: "error", message: "the finish report secret didn't open" });
    return;
  }
  const carriedOn = await context.registry.detach(request, secret, () => {
    context.server.close();
  });
  send({ type: "detached", carriedOn });
};

/** Opens a session record's sealed sinks; `undefined` when they don't open. */
const recordSecrets = (
  request: SessionRequest,
  keys: SealingKeys,
): RecordSecrets | undefined => {
  const sealed = request.record?.sealed;
  if (sealed === undefined) {
    return {};
  }
  const opened = openSecret(keys.privateKey, sealed);
  const decoded = opened === undefined ? undefined : decodeSecrets(opened);
  return decoded !== undefined && Either.isRight(decoded)
    ? decoded.right
    : undefined;
};

/** Starts a session, once its record's sinks have opened. */
const startSession = (
  request: SessionRequest,
  socket: Socket,
  context: Context,
): void => {
  const secrets = recordSecrets(request, context.keys);
  if (secrets === undefined) {
    sender(socket)({
      type: "error",
      message: "the session record's sinks didn't open",
    });
    socket.end();
    return;
  }
  context.registry.start({
    request,
    secrets,
    send: sender(socket),
    done: () => {
      socket.end();
    },
  });
};

const handle = (request: Request, socket: Socket, context: Context): void => {
  const send = sender(socket);
  switch (request.type) {
    case "hello": {
      send({
        type: "hello",
        pid: process.pid,
        publicKey: context.keys.publicKey,
      });
      socket.end();
      return;
    }
    case "detach": {
      void detach(request, send, context).finally(() => {
        socket.end();
      });
      return;
    }
    case "session": {
      startSession(request, socket, context);
      return;
    }
    case "kill": {
      void answer(socket, context.registry.kill(request.id));
      return;
    }
    case "input": {
      void replyOnce(socket, context.registry.input(request));
      return;
    }
    case "shutdown": {
      void answer(socket, context.registry.shutdown()).finally(() => {
        context.server.close();
      });
    }
  }
};

const onConnection =
  (context: Context) =>
  (socket: Socket): void => {
    socket.on("error", () => undefined);
    const lines = createInterface({ input: socket });
    lines.once("line", (line) => {
      lines.close();
      const request = decodeRequest(line);
      if (Either.isLeft(request)) {
        sender(socket)({ type: "error", message: "unreadable request" });
        socket.end();
        return;
      }
      handle(request.right, socket, context);
    });
  };

/** Runs the supervisor in the current directory until a `shutdown` request. */
export const runDaemon = async (): Promise<void> => {
  await Promise.all(
    ["sessions", "replays"].map(async (dir) => mkdir(dir, { recursive: true })),
  );
  await rm(SOCKET, { force: true });
  // Made before it listens, so the host learns the public half before any
  // session can run: a session can't swap in its own.
  const keys = await makeSealingKeys();
  const board = new StatusBoard();
  // On disk before it answers: a reattach finds the supervisor by this file.
  await board.flushed();
  const registry = new SessionRegistry(board);
  const server = createServer();
  server.on("connection", onConnection({ registry, server, keys }));
  const closed = once(server, "close");
  server.listen(SOCKET);
  await closed;
  await board.exited();
};
