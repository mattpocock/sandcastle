import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { Either, Schema } from "effect";
import type { Reply, Request } from "./supervisorProtocol.js";
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

const handle = (
  request: Request,
  socket: Socket,
  context: { readonly registry: SessionRegistry; readonly server: Server },
): void => {
  const send = sender(socket);
  switch (request.type) {
    case "hello": {
      send({ type: "hello", pid: process.pid });
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
  (context: { readonly registry: SessionRegistry; readonly server: Server }) =>
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
  const registry = new SessionRegistry();
  const server = createServer();
  server.on("connection", onConnection({ registry, server }));
  const closed = once(server, "close");
  server.listen(SOCKET);
  await closed;
};
