import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Schema } from "effect";
import type { OutputObjectDefinition } from "../Output.js";

/** What the `implement` task hands back, in its `implementResult` tag. */
export interface ImplementResult {
  /**
   * `pr-opened`: a new PR from `branch`. `pr-updated`: new commits pushed to
   * the branch's open PR. `no-changes`: nothing needed changing, so no PR.
   * `blocked`: the work couldn't go on, e.g. the ticket couldn't be fetched.
   */
  readonly status: "pr-opened" | "pr-updated" | "no-changes" | "blocked";
  /** The branch the work is on. */
  readonly branch: string;
  /** The PR, when one was opened or updated. */
  readonly pr?: { readonly number: number; readonly url: string };
  /** What was done, or why it's blocked, in a few sentences. */
  readonly summary: string;
}

const ImplementResultSchema = Schema.Struct({
  status: Schema.Literal("pr-opened", "pr-updated", "no-changes", "blocked"),
  branch: Schema.String,
  pr: Schema.optional(
    Schema.Struct({ number: Schema.Number, url: Schema.String }),
  ),
  summary: Schema.String,
});

const schema: StandardSchemaV1<unknown, ImplementResult> =
  Schema.standardSchemaV1(ImplementResultSchema);

/** The `implement` task's output: `implementResult`, as JSON. */
export const IMPLEMENT_RESULT: OutputObjectDefinition<ImplementResult> = {
  _tag: "object",
  tag: "implementResult",
  schema,
};

/** `implement.outputs`: the `implementResult` output, under the session's name. */
export type ImplementOutputs = Readonly<
  Record<"implement", OutputObjectDefinition<ImplementResult>>
>;
