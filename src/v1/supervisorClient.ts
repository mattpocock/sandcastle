import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { connect } from "node:net";
import { Data, Effect, Either, Schedule, Schema } from "effect";
import { SOCKET } from "./supervisorDaemon.js";
import { STATUS_FILE, SupervisorStatusJson } from "./supervisorStatusSchema.js";

// The short-lived half of the session supervisor: the host runs it with
// exec for each request. It hands the request file the host wrote to the
// supervisor over its socket, deletes the file, and prints the replies on
// stdout, where the host reads them through the exec stream.

/** The supervisor's socket refused the connection, or isn't there yet. */
class SupervisorUnreachable extends Data.TaggedError("SupervisorUnreachable")<{
  readonly cause: Error;
}> {}

const decodeStatus = Schema.decodeUnknownEither(SupervisorStatusJson);

/** The supervisor has said in its status file that it has stopped. */
class SupervisorExited extends Data.TaggedError("SupervisorExited") {}

/** Fails with SupervisorExited once the status file says the supervisor has stopped. */
const notExited = Effect.promise(async () =>
  readFile(STATUS_FILE, "utf8").catch(() => ""),
).pipe(
  Effect.flatMap((text) => {
    const status = decodeStatus(text);
    return Either.isRight(status) && status.right.supervisor === "exited"
      ? Effect.fail(new SupervisorExited())
      : Effect.void;
  }),
);

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

/**
 * Connects, waiting up to 15 s for a supervisor that is still starting. The
 * status file is read again before each try, so a supervisor that stopped
 * after the host last looked (it exits once its finish report is out) is
 * given up on at once rather than waited for.
 */
const connectToSupervisor = notExited.pipe(
  Effect.zipRight(connectOnce),
  Effect.retry({
    schedule: Schedule.spaced("100 millis").pipe(
      Schedule.intersect(Schedule.recurs(150)),
    ),
    while: (error) => error._tag === "SupervisorUnreachable",
  }),
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
