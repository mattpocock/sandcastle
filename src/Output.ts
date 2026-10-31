import type { StandardSchemaV1 } from "@standard-schema/spec";

// ---------------------------------------------------------------------------
// Output definition types (branded values for run() overload discrimination)
// ---------------------------------------------------------------------------

/** Branded output definition for `Output.object({ tag, schema })`. */
export interface OutputObjectDefinition<T> {
  readonly _tag: "object";
  readonly tag: string;
  readonly schema: StandardSchemaV1<unknown, T>;
  /**
   * Maximum number of additional attempts after the first if structured output
   * extraction or validation fails. Each retry resumes the failed run's agent
   * session and feeds back a token-efficient description of the error so the
   * agent can re-emit a corrected tag. Default: `0` (no retries).
   *
   * Retries require the agent provider to support session resumption (i.e.
   * `provider.sessionStorage` is populated — Claude Code, Codex, Pi). `run()`
   * fails at entry with a clear error when retries are requested but the
   * provider cannot resume.
   */
  readonly maxRetries?: number;
}

/** Branded output definition for `Output.string({ tag })`. */
export interface OutputStringDefinition {
  readonly _tag: "string";
  readonly tag: string;
  /**
   * Maximum number of additional attempts after the first if structured output
   * extraction fails. Each retry resumes the failed run's agent session and
   * feeds back a token-efficient description of the error so the agent can
   * re-emit a corrected tag. Default: `0` (no retries).
   *
   * Retries require the agent provider to support session resumption (i.e.
   * `provider.sessionStorage` is populated — Claude Code, Codex, Pi). `run()`
   * fails at entry with a clear error when retries are requested but the
   * provider cannot resume.
   */
  readonly maxRetries?: number;
}

/** Union of all output definition shapes accepted by `run()`. */
export type OutputDefinition =
  | OutputObjectDefinition<any>
  | OutputStringDefinition;

// ---------------------------------------------------------------------------
// Output namespace — public API
// ---------------------------------------------------------------------------

/**
 * Helpers for declaring structured output on `run()`.
 *
 * ```ts
 * import { Output, run } from "@ai-hero/sandcastle";
 * import { z } from "zod";
 *
 * const result = await run({
 *   output: Output.object({ tag: "result", schema: z.object({ answer: z.number() }) }),
 *   // ...
 * });
 * console.log(result.output.answer); // typed as number
 * ```
 */
export const Output = {
  /**
   * Declare an object-typed structured output extracted from an XML tag in
   * the agent's stdout. The tag contents are JSON-parsed (with fence-aware
   * unwrapping) and validated against the provided Standard Schema validator.
   *
   * Set `maxRetries` to have `run()` automatically resume the failed session
   * and ask the agent to re-emit corrected output when extraction or
   * validation fails. Default: `0` (no retries).
   */
  object: <Schema extends StandardSchemaV1>(opts: {
    tag: string;
    schema: Schema;
    maxRetries?: number;
  }): OutputObjectDefinition<StandardSchemaV1.InferOutput<Schema>> => ({
    _tag: "object",
    tag: opts.tag,
    schema: opts.schema,
    maxRetries: opts.maxRetries,
  }),

  /**
   * Declare a string-typed structured output extracted from an XML tag in
   * the agent's stdout. The tag contents are whitespace-trimmed and returned
   * as a plain string — no JSON parsing, no schema validation.
   *
   * Set `maxRetries` to have `run()` automatically resume the failed session
   * and ask the agent to re-emit corrected output when extraction fails.
   * Default: `0` (no retries).
   */
  string: (opts: {
    tag: string;
    maxRetries?: number;
  }): OutputStringDefinition => ({
    _tag: "string",
    tag: opts.tag,
    maxRetries: opts.maxRetries,
  }),
} as const;

// ---------------------------------------------------------------------------
// StructuredOutputError
// ---------------------------------------------------------------------------

export interface StructuredOutputErrorOptions {
  readonly tag: string;
  readonly rawMatched: string | undefined;
  readonly cause?: unknown;
  readonly commits: { sha: string }[];
  readonly branch: string;
  readonly preservedWorktreePath?: string;
  readonly sessionId?: string;
  readonly sessionFilePath?: string;
}

/**
 * Thrown by `run()` when structured output extraction or validation fails.
 *
 * Possible failure modes:
 * - The configured XML tag was not found in stdout (`rawMatched` is `undefined`).
 * - The tag contents failed `JSON.parse` (`cause` carries the parse error).
 * - The parsed JSON failed schema validation (`cause` carries the Standard Schema issues).
 *
 * The error carries `commits`, `branch`, and optionally `preservedWorktreePath`
 * so callers can decide recovery without losing the run's side effects.
 *
 * It also carries `sessionId` (and `sessionFilePath` when the session was
 * captured to the host) of the iteration that produced the bad output, so a
 * caller can resume that same session and ask the agent to re-emit corrected
 * output:
 *
 * ```ts
 * try {
 *   return await run({ ...opts, output });
 * } catch (e) {
 *   if (e instanceof StructuredOutputError && e.sessionId) {
 *     return await run({
 *       ...opts,
 *       output,
 *       resumeSession: e.sessionId,
 *       prompt: feedback(e),
 *     });
 *   }
 *   throw e;
 * }
 * ```
 */
export class StructuredOutputError extends Error {
  readonly tag: string;
  readonly rawMatched: string | undefined;
  override readonly cause: unknown;
  readonly commits: { sha: string }[];
  readonly branch: string;
  readonly preservedWorktreePath?: string;
  /** Session ID of the iteration that produced the bad output, when available. */
  readonly sessionId?: string;
  /** Host path to the captured session JSONL, when the session was captured. */
  readonly sessionFilePath?: string;

  constructor(message: string, options: StructuredOutputErrorOptions) {
    super(message);
    this.name = "StructuredOutputError";
    this.tag = options.tag;
    this.rawMatched = options.rawMatched;
    this.cause = options.cause;
    this.commits = options.commits;
    this.branch = options.branch;
    this.preservedWorktreePath = options.preservedWorktreePath;
    this.sessionId = options.sessionId;
    this.sessionFilePath = options.sessionFilePath;
  }
}
