import { Cause, Effect, Exit } from "effect";

/**
 * Runs an Effect to a Promise for the public API. Unlike `Effect.runPromise`,
 * which rejects with a `FiberFailure` wrapper whose stack is Effect internals,
 * this rejects with the error itself: the typed failure (e.g. `ExecError`,
 * `AgentError`) when there is one, otherwise the defect or interruption, as
 * `Cause.squash` picks it (#1365).
 */
export const runPromise = <A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.originalError(Cause.squash(exit.cause));
  });
