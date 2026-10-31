import { Deferred, Effect } from "effect";

/**
 * Race an Effect against an optional `AbortSignal`.
 *
 * - If no signal is provided, the effect runs unmodified.
 * - If the signal is already aborted at call time, dies immediately with
 *   `signal.reason`.
 * - Otherwise, races the effect against a Deferred that fires when the
 *   signal aborts.
 *
 * Uses `Effect.die` so the abort reason propagates as a defect — callers
 * should use `signal.throwIfAborted()` in their catch handler to surface
 * the original reason without Sandcastle-specific wrapping.
 *
 * The abort listener is always cleaned up, even when the effect wins the race.
 */
export const raceAbortSignal = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal?: AbortSignal,
): Effect.Effect<A, E, R> => {
  if (!signal) return effect;

  return Effect.gen(function* () {
    if (signal.aborted) {
      return yield* Effect.die(signal.reason);
    }

    const abortDeferred = yield* Deferred.make<never>();
    const onAbort = () => {
      Effect.runPromise(Deferred.die(abortDeferred, signal.reason)).catch(
        () => {},
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });

    return yield* Effect.raceFirst(effect, Deferred.await(abortDeferred)).pipe(
      Effect.ensuring(
        Effect.sync(() => signal.removeEventListener("abort", onAbort)),
      ),
    );
  });
};
