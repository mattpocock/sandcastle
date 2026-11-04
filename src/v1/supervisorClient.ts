import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { connect } from "node:net";
import { Data, Effect, Schedule } from "effect";
import { SOCKET } from "./supervisorDaemon.js";

// The short-lived half of the session supervisor: the host runs it with
// exec for each request. It hands the request file the host wrote to the
// supervisor over its socket, deletes the file, and prints the replies on
// stdout, where the host reads them through the exec stream.

/** The supervisor's socket refused the connection, or isn't there yet. */
class SupervisorUnreachable extends Data.TaggedError("SupervisorUnreachable")<{
  readonly cause: Error;
}> {}

const connectOnce = Effect.async<Socket, SupervisorUnreachable>((resume) => {
  const socket = connect(SOCKET);
  socket.once("connect", () => {
    socket.removeAllListeners("error");
    resume(Effect.succeed(socket));
  });
  socket.once("error", (error) => {
    resume(Effect.fail(new SupervisorUnreachable({ cause: error })));
  });
});

/** Connects, waiting up to 15 s for a supervisor that is still starting. */
const connectToSupervisor = connectOnce.pipe(
  Effect.retry(
    Schedule.spaced("100 millis").pipe(
      Schedule.intersect(Schedule.recurs(150)),
    ),
  ),
);

/** Sends one request; resolves with the client's exit code. */
export const runClient = async (requestFile: string): Promise<number> => {
  const request = await readFile(requestFile, "utf8");
  await rm(requestFile, { force: true });
  const socket = await Effect.runPromise(
    Effect.either(connectToSupervisor),
  ).then((result) => (result._tag === "Right" ? result.right : undefined));
  if (socket === undefined) {
    process.stderr.write("The session supervisor isn't running.\n");
    return 3;
  }
  socket.pipe(process.stdout, { end: false });
  socket.write(`${request.trim()}\n`);
  await once(socket, "close");
  return 0;
};
