import { Data } from "effect";

/** Why `detach()` refused. */
export type DetachErrorReason =
  | "nothing-running"
  | "awaited-call-pending"
  | "supervisor-unreachable";

interface DetachErrorArgs {
  readonly message: string;
  readonly reason: DetachErrorReason;
  readonly cause?: unknown;
}

class DetachErrorImpl extends Data.TaggedError(
  "DetachError",
)<DetachErrorArgs> {}

/**
 * `detach()` rejects with this. Nothing was detached: you still hold the
 * handle, and `close()` still ends the sandbox.
 */
export interface DetachError extends Error {
  readonly _tag: "DetachError";
  /**
   * - `nothing-running`: no spawned session is running, so there's nothing to carry on. Close instead.
   * - `awaited-call-pending`: an awaited call on the handle (`exec`, `session`, `spawnSession`, a file read or write) hasn't settled yet.
   * - `supervisor-unreachable`: the session supervisor didn't confirm it holds the work.
   */
  readonly reason: DetachErrorReason;
  /** What went wrong underneath, when there was an underlying error. */
  readonly cause?: unknown;
}

interface DetachErrorConstructor {
  new (args: DetachErrorArgs): DetachError;
  readonly prototype: DetachError;
}

/**
 * `detach()` rejects with this. Nothing was detached: you still hold the
 * handle, and `close()` still ends the sandbox.
 */
export const DetachError: DetachErrorConstructor = DetachErrorImpl;
