import { Data } from "effect";

interface SandboxUnavailableErrorArgs {
  readonly message: string;
  readonly sandboxId: string;
}

class SandboxUnavailableErrorImpl extends Data.TaggedError(
  "SandboxUnavailableError",
)<SandboxUnavailableErrorArgs> {}

/**
 * The sandbox is gone: it was closed, hit its kill time, or never existed on
 * this provider. `reattachSandbox` rejects with it, and so does `status()`
 * once the sandbox has ended. Other failures (a network error, a bad key)
 * reject with the provider's own error, so "ended" and "unknown" differ.
 */
export interface SandboxUnavailableError extends Error {
  readonly _tag: "SandboxUnavailableError";
  /** The sandbox that couldn't be found. */
  readonly sandboxId: string;
}

interface SandboxUnavailableErrorConstructor {
  new (args: SandboxUnavailableErrorArgs): SandboxUnavailableError;
  readonly prototype: SandboxUnavailableError;
}

/**
 * The sandbox is gone: it was closed, hit its kill time, or never existed on
 * this provider. `reattachSandbox` rejects with it, and so does `status()`
 * once the sandbox has ended. Other failures (a network error, a bad key)
 * reject with the provider's own error, so "ended" and "unknown" differ.
 */
export const SandboxUnavailableError: SandboxUnavailableErrorConstructor =
  SandboxUnavailableErrorImpl;
