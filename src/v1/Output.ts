import type { StandardSchemaV1 } from "@standard-schema/spec";

/** A session's JSON output, validated against a Standard Schema. Make one with `Output.object`. */
export interface OutputObjectDefinition<T> {
  readonly _tag: "object";
  /** The tag the agent prints its result between. */
  readonly tag: string;
  readonly schema: StandardSchemaV1<unknown, T>;
}

/** A session's text output. Make one with `Output.string`. */
export interface OutputStringDefinition {
  readonly _tag: "string";
  /** The tag the agent prints its result between. */
  readonly tag: string;
}

/** Either kind of session output. */
export type OutputDefinition =
  | OutputObjectDefinition<unknown>
  | OutputStringDefinition;

/**
 * Structured output for a session. The agent prints its result between
 * `<tag>` and `</tag>`; the prompt must ask it to, and must contain `<tag>`.
 */
export const Output = {
  /** JSON between the tags, validated against a Standard Schema (Zod, Valibot, Effect Schema…). */
  object: <Schema extends StandardSchemaV1>(options: {
    readonly tag: string;
    readonly schema: Schema;
  }): OutputObjectDefinition<StandardSchemaV1.InferOutput<Schema>> => ({
    _tag: "object",
    tag: options.tag,
    schema: options.schema,
  }),
  /** The trimmed text between the tags. */
  string: (options: { readonly tag: string }): OutputStringDefinition => ({
    _tag: "string",
    tag: options.tag,
  }),
} as const;
