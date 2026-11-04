import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { Either, Schema } from "effect";
import type { SealingKeys } from "./sealedSecret.js";
import { makeSealingKeys, openSecret } from "./sealedSecret.js";
import type { DetachRequest, Reply, Request } from "./supervisorProtocol.js";
import { RequestJson } from "./supervisorProtocol.js";
import { SessionRegistry } from "./supervisorRegistry.js";

// The session supervisor's long-running half. It runs in its own directory
// inside the sandbox and listens on a Unix socket there (a relative path, so
// a deep sandbox home can't push it past the socket path limit). Each
// connection carries one request from the host's short-lived client and the
// replies to it.

/** The supervisor's socket, relative to its directory. */
export const SOCKET = "control.sock";

const decodeRequest = Schema.decodeUnknownEither(RequestJson);

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

interface Context {
  readonly registry: SessionRegistry;
  readonly server: Server;
  readonly keys: SealingKeys;
}

/** Carries the running sessions on; the supervisor stops once they're reported. */
const detach = (
  request: DetachRequest,
  send: (reply: Reply) => void,
  context: Context,
): void => {
  const sealed = request.finishReport?.sealedSecret;
  const secret =
    sealed === undefined
      ? undefined
      : openSecret(context.keys.privateKey, sealed);
  if (sealed !== undefined && secret === undefined) {
    send({ type: "error", message: "the finish report secret didn't open" });
    return;
  }
  const carriedOn = context.registry.detach(request, secret, () => {
    context.server.close();
  });
  send({ type: "detached", carriedOn });
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
      detach(request, send, context);
      socket.end();
      return;
    }
    case "session": {
      context.registry.start(request, send, () => {
        socket.end();
      });
      return;
    }
    case "kill": {
      void answer(socket, context.registry.kill(request.id));
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
  const registry = new SessionRegistry();
  const server = createServer();
  server.on("connection", onConnection({ registry, server, keys }));
  const closed = once(server, "close");
  server.listen(SOCKET);
  await closed;
};
