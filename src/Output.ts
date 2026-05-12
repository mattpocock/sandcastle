import type { StandardSchemaV1 } from "@standard-schema/spec";

// ---------------------------------------------------------------------------
// Output definition types (branded values for run() overload discrimination)
// ---------------------------------------------------------------------------

/** Branded output definition for `Output.object({ tag, schema })`. */
export interface OutputObjectDefinition<T> {
  readonly _tag: "object";
  readonly tag: string;
  readonly schema: StandardSchemaV1<unknown, T>;
}

/** Branded output definition for `Output.string({ tag })`. */
export interface OutputStringDefinition {
  readonly _tag: "string";
  readonly tag: string;
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
   */
  object: <Schema extends StandardSchemaV1>(opts: {
    tag: string;
    schema: Schema;
  }): OutputObjectDefinition<StandardSchemaV1.InferOutput<Schema>> => ({
    _tag: "object",
    tag: opts.tag,
    schema: opts.schema as StandardSchemaV1<
      unknown,
      StandardSchemaV1.InferOutput<Schema>
    >,
  }),

  /**
   * Declare a string-typed structured output extracted from an XML tag in
   * the agent's stdout. The tag contents are whitespace-trimmed and returned
   * as a plain string — no JSON parsing, no schema validation.
   */
  string: (opts: { tag: string }): OutputStringDefinition => ({
    _tag: "string",
    tag: opts.tag,
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
 */
export class StructuredOutputError extends Error {
  readonly tag: string;
  readonly rawMatched: string | undefined;
  override readonly cause: unknown;
  readonly commits: { sha: string }[];
  readonly branch: string;
  readonly preservedWorktreePath?: string;

  constructor(message: string, options: StructuredOutputErrorOptions) {
    super(message);
    this.name = "StructuredOutputError";
    this.tag = options.tag;
    this.rawMatched = options.rawMatched;
    this.cause = options.cause;
    this.commits = options.commits;
    this.branch = options.branch;
    this.preservedWorktreePath = options.preservedWorktreePath;
  }
}
