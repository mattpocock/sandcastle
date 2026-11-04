import { Data } from "effect";

interface SandboxDetachedErrorArgs {
  readonly message: string;
  readonly sandboxId: string;
  readonly detachId: string;
}

class SandboxDetachedErrorImpl extends Data.TaggedError(
  "SandboxDetachedError",
)<SandboxDetachedErrorArgs> {}

/**
 * Every call on a handle after `detach()` rejects with this, and so do
 * `wait()` and `kill()` on the sessions it carried on: the work goes on
 * without the handle, and its result arrives in the finish report.
 */
export interface SandboxDetachedError extends Error {
  readonly _tag: "SandboxDetachedError";
  /** The sandbox that was detached from. */
  readonly sandboxId: string;
  /** The detach, as in its `DetachReceipt`. */
  readonly detachId: string;
}

interface SandboxDetachedErrorConstructor {
  new (args: SandboxDetachedErrorArgs): SandboxDetachedError;
  readonly prototype: SandboxDetachedError;
}

/**
 * Every call on a handle after `detach()` rejects with this, and so do
 * `wait()` and `kill()` on the sessions it carried on: the work goes on
 * without the handle, and its result arrives in the finish report.
 */
export const SandboxDetachedError: SandboxDetachedErrorConstructor =
  SandboxDetachedErrorImpl;
