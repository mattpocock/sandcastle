import { Schema } from "effect";
import type { OutputObjectDefinition } from "./Output.js";
import { Output } from "./Output.js";

/** What a merge run hands back, in its `mergeResult` tag. */
export interface MergeResult {
  /**
   * `merged`: `into` now holds `from`, with a merge commit, and is pushed (or
   * already held it). `conflict-unresolved`: the conflicts couldn't be
   * resolved keeping both sides' intent. `checks-failed`: the merged code
   * fails the repo's checks. `blocked`: the merge couldn't go on, e.g. the
   * push was rejected. Nothing is pushed unless it's `merged`.
   */
  readonly status:
    | "merged"
    | "conflict-unresolved"
    | "checks-failed"
    | "blocked";
  /** The branch merged into. */
  readonly into: string;
  /** `into`'s new tip on `origin`, when it's `merged`. */
  readonly commit?: string;
  /** What was merged and checked, or why it wasn't, in a few sentences. */
  readonly summary: string;
}

/** `merge.outputs(name)`: the `mergeResult` output, under the session's name. */
export type MergeOutputs<Name extends string = "merge"> = Readonly<
  Record<Name, OutputObjectDefinition<MergeResult>>
>;

/** The `mergeResult` output a merge session ends with. */
export const MERGE_RESULT: OutputObjectDefinition<MergeResult> = Output.object({
  tag: "mergeResult",
  schema: Schema.standardSchemaV1(
    Schema.Struct({
      status: Schema.Literal(
        "merged",
        "conflict-unresolved",
        "checks-failed",
        "blocked",
      ),
      into: Schema.String,
      commit: Schema.optional(Schema.String),
      summary: Schema.String,
    }),
  ),
});
