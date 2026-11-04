import type { Sandbox as DaytonaSandbox } from "@daytona/sdk";
import { Data, Effect } from "effect";

// A Daytona session command's log stream closes only when its command ends.
// If the session's shell is killed instead, the stream would wait forever,
// so a streamed exec also watches the shell through the PID file it wrote.

/** How often a streamed exec checks that its session's shell is alive. */
const WATCH_INTERVAL = "15 seconds";

/** A running session command, and the file holding its shell's PID. */
export interface SessionCommand {
  readonly sessionId: string;
  readonly cmdId: string;
  readonly pidPath: string;
}

/** The session's shell ended without recording its command's exit code. */
export class DaytonaSessionLostError extends Data.TaggedError(
  "DaytonaSessionLostError",
)<{ readonly message: string }> {}

/**
 * Whether a session's shell is `alive`; if not, whether its command `exited`
 * with a recorded exit code or was `lost` without one. A missing PID file
 * counts as alive, so the watch can never fail a command that hasn't written
 * it yet.
 */
const probe = async (
  sandbox: DaytonaSandbox,
  { sessionId, cmdId, pidPath }: SessionCommand,
): Promise<"alive" | "exited" | "lost"> => {
  const alive = await sandbox.process
    .executeCommand(`test ! -f ${pidPath} || kill -0 "$(cat ${pidPath})"`)
    .then((result) => result.exitCode === 0)
    .catch(() => true);
  if (alive) {
    return "alive";
  }
  const command = await sandbox.process
    .getSessionCommand(sessionId, cmdId)
    .catch(() => undefined);
  return typeof command?.exitCode === "number" ? "exited" : "lost";
};

/**
 * Watches a session's shell. Succeeds once the shell has ended with its
 * command's exit code recorded; fails if it ended without one. Runs until
 * then, so race it against the command's log stream.
 */
export const watchSessionShell = (
  sandbox: DaytonaSandbox,
  session: SessionCommand,
): Effect.Effect<void, DaytonaSessionLostError> =>
  Effect.sleep(WATCH_INTERVAL).pipe(
    Effect.zipRight(Effect.promise(async () => probe(sandbox, session))),
    Effect.repeat({ while: (state) => state === "alive" }),
    Effect.flatMap((state) =>
      state === "exited"
        ? Effect.void
        : Effect.fail(
            new DaytonaSessionLostError({
              message:
                "the Daytona session's shell ended before its command did, so the command's exit code is unknown",
            }),
          ),
    ),
  );
