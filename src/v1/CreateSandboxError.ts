import { Data } from "effect";

class CreateSandboxErrorImpl extends Data.TaggedError("CreateSandboxError")<{
  readonly message: string;
  readonly sandboxId?: string;
  readonly cause?: unknown;
}> {}

/**
 * `createSandbox` rejects with this when the sandbox couldn't be created or
 * made ready. Whatever was created has been closed, so it's safe to retry.
 */
export interface CreateSandboxError extends Error {
  readonly _tag: "CreateSandboxError";
  /** Set when the provider created a sandbox before the failure (it has been closed). */
  readonly sandboxId?: string;
  /** What went wrong underneath, when there was an underlying error. */
  readonly cause?: unknown;
}

interface CreateSandboxErrorConstructor {
  new (args: {
    readonly message: string;
    readonly sandboxId?: string;
    readonly cause?: unknown;
  }): CreateSandboxError;
  readonly prototype: CreateSandboxError;
}

/**
 * `createSandbox` rejects with this when the sandbox couldn't be created or
 * made ready. Whatever was created has been closed, so it's safe to retry.
 */
export const CreateSandboxError: CreateSandboxErrorConstructor =
  CreateSandboxErrorImpl;
