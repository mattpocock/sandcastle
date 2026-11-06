import { Data } from "effect";

/** Why `send()` didn't hand a message to a session. */
export type SessionInputErrorReason =
  | "no-such-session"
  | "ambiguous-session"
  | "stopped-taking-input"
  | "agent-takes-no-input";

interface SessionInputErrorArgs {
  readonly message: string;
  readonly reason: SessionInputErrorReason;
  readonly cause?: unknown;
}

class SessionInputErrorImpl extends Data.TaggedError(
  "SessionInputError",
)<SessionInputErrorArgs> {}

/**
 * `send()` rejects with this when its message didn't reach the session's
 * agent. Nothing was written to it.
 */
export interface SessionInputError extends Error {
  readonly _tag: "SessionInputError";
  /**
   * - `no-such-session`: no session by that name is running (or none is, or the session supervisor has exited). Read its result or record instead.
   * - `ambiguous-session`: no name was given and several sessions are running. Pass `session`.
   * - `stopped-taking-input`: the agent has finished its last turn and is exiting, or the session has just ended.
   * - `agent-takes-no-input`: the session's agent can't take messages while it runs (see `acceptsInput`).
   */
  readonly reason: SessionInputErrorReason;
  /** What went wrong underneath, when there was an underlying error. */
  readonly cause?: unknown;
}

interface SessionInputErrorConstructor {
  new (args: SessionInputErrorArgs): SessionInputError;
  readonly prototype: SessionInputError;
}

/**
 * `send()` rejects with this when its message didn't reach the session's
 * agent. Nothing was written to it.
 */
export const SessionInputError: SessionInputErrorConstructor =
  SessionInputErrorImpl;
