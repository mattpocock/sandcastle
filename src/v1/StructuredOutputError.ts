import { Data } from "effect";

interface StructuredOutputErrorArgs {
  readonly message: string;
  readonly sessionName: string;
  readonly tag: string;
  readonly rawMatched?: string;
  readonly sessionId?: string;
  readonly cause?: unknown;
}

class StructuredOutputErrorImpl extends Data.TaggedError(
  "StructuredOutputError",
)<StructuredOutputErrorArgs> {}

/**
 * A session with `output` rejects with this when the agent finished but its
 * output tag was missing, held invalid JSON, or failed the schema.
 */
export interface StructuredOutputError extends Error {
  readonly _tag: "StructuredOutputError";
  /** The session's name. */
  readonly sessionName: string;
  /** The output's tag. */
  readonly tag: string;
  /** What the agent printed between the tags, when it printed them. */
  readonly rawMatched?: string;
  /** The agent's own session id, so you can continue it and ask again. */
  readonly sessionId?: string;
  /** The schema's issues, or the JSON parse error. */
  readonly cause?: unknown;
}

interface StructuredOutputErrorConstructor {
  new (args: StructuredOutputErrorArgs): StructuredOutputError;
  readonly prototype: StructuredOutputError;
}

/**
 * A session with `output` rejects with this when the agent finished but its
 * output tag was missing, held invalid JSON, or failed the schema.
 */
export const StructuredOutputError: StructuredOutputErrorConstructor =
  StructuredOutputErrorImpl;
