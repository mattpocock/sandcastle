import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  OutputObjectDefinition,
  OutputStringDefinition,
} from "../Output.js";

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
