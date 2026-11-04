import { Schema } from "effect";
import type { OutputObjectDefinition } from "../Output.js";
import { Output } from "../Output.js";

/** What a review run hands back: one verdict, the findings behind it, and a summary. */
export interface ReviewResult {
  /** `changes-requested` on any hard standards violation or any missing, partial or wrong requirement. */
  readonly verdict: "approve" | "changes-requested";
  /** The findings behind `changes-requested`, one self-contained string each; empty on `approve`. Pass them to the next implement round. */
  readonly comments: readonly string[];
  /** The review's one-line summary. */
  readonly summary: string;
}

/** `review.outputs`: the `reviewResult` output, under the session's name. */
export type ReviewOutputs = Readonly<{
  review: OutputObjectDefinition<ReviewResult>;
}>;

/** The `reviewResult` output a review session ends with. */
export const REVIEW_RESULT: OutputObjectDefinition<ReviewResult> =
  Output.object({
    tag: "reviewResult",
    schema: Schema.standardSchemaV1(
      Schema.Struct({
        verdict: Schema.Literal("approve", "changes-requested"),
        comments: Schema.Array(Schema.String),
        summary: Schema.String,
      }),
    ),
  });
