import { Data } from "effect";

class ExecFailedErrorImpl extends Data.TaggedError("ExecFailedError")<{
  readonly message: string;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {}

/**
 * `exec` rejects with this when the command exits non-zero, unless you passed
 * `allowFailure: true`.
 */
export interface ExecFailedError extends Error {
  readonly _tag: "ExecFailedError";
  /** The command that failed. */
  readonly command: string;
  /** Its non-zero exit code. */
  readonly exitCode: number;
  /** Everything it printed to stdout. */
  readonly stdout: string;
  /** Everything it printed to stderr. */
  readonly stderr: string;
}

interface ExecFailedErrorConstructor {
  new (args: {
    readonly message: string;
    readonly command: string;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }): ExecFailedError;
  readonly prototype: ExecFailedError;
}

/**
 * `exec` rejects with this when the command exits non-zero, unless you passed
 * `allowFailure: true`.
 */
export const ExecFailedError: ExecFailedErrorConstructor = ExecFailedErrorImpl;
