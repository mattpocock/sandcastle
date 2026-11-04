import { Effect } from "effect";

/**
 * Run a provider's `create()`. If we stop waiting for it (the start timeout
 * fires, or the caller is interrupted) the provider still finishes creating
 * the sandbox, and nobody holds its handle. Close that handle when it
 * arrives, so a late sandbox never outlives the run.
 */
export const createClosingIfAbandoned = <
  H extends { close: () => Promise<void> },
  E,
>(
  create: () => Promise<H>,
  onError: (e: unknown) => E,
): Effect.Effect<H, E> =>
  Effect.suspend(() => {
    let pending: Promise<H> | undefined;
    return Effect.tryPromise({
      try: () => (pending = create()),
      catch: onError,
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          // A late close that fails has no one left to report to.
          pending?.then((handle) => handle.close()).catch(() => undefined);
        }),
      ),
    );
  });
