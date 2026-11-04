import { Data } from "effect";

interface SessionFailedErrorArgs {
  readonly message: string;
  readonly sessionName: string;
  readonly exitReason: "failed" | "idle-timeout" | "aborted";
  readonly started: boolean;
  readonly exitCode?: number;
  readonly sessionId?: string;
  readonly outputTail: string;
  readonly cause?: unknown;
}

class SessionFailedErrorImpl extends Data.TaggedError(
  "SessionFailedError",
)<SessionFailedErrorArgs> {}

/**
 * A session rejects with this when its agent couldn't start, exited non-zero,
 * reported an error, went silent past `idleTimeoutSeconds`, or was stopped.
 */
export interface SessionFailedError extends Error {
  readonly _tag: "SessionFailedError";
  /** The session's name. */
  readonly sessionName: string;
  /** `failed` (it couldn't start, exited non-zero or reported an error), `idle-timeout` or `aborted`. */
  readonly exitReason: "failed" | "idle-timeout" | "aborted";
  /** Whether the agent had started: `false` when `spawnSession()` rejects. */
  readonly started: boolean;
  /** The agent's exit code, when it exited by itself. */
  readonly exitCode?: number;
  /** The agent's own session id, when it reported one. */
  readonly sessionId?: string;
  /** The last few KB the agent printed. */
  readonly outputTail: string;
  /** What went wrong underneath, when there was an underlying error. */
  readonly cause?: unknown;
}

interface SessionFailedErrorConstructor {
  new (args: SessionFailedErrorArgs): SessionFailedError;
  readonly prototype: SessionFailedError;
}

/**
 * A session rejects with this when its agent couldn't start, exited non-zero,
 * reported an error, went silent past `idleTimeoutSeconds`, or was stopped.
 */
export const SessionFailedError: SessionFailedErrorConstructor =
  SessionFailedErrorImpl;
