import type { FinishReport, OutputObjectDefinition } from "../v1.js";
import type { ImplementResult } from "./implementResult.js";
import type { RoundResult, SessionOutcome } from "./implementSpecProgress.js";
import type {
  ImplementSpecRoundSession,
  ImplementSpecSessions,
  ImplementSpecState,
} from "./implementSpecTypes.js";
import { implement } from "./taskImplement.js";
import { merge } from "./taskMerge.js";
import type { MergeResult } from "./taskMergeResult.js";
import { review } from "./taskReview.js";
import type { ReviewResult } from "./taskReviewResult.js";

// How a round's sessions ended: read from its finish report after a detach,
// or from the sessions themselves on a held handle.

type RoundOutput =
  | OutputObjectDefinition<ImplementResult>
  | OutputObjectDefinition<MergeResult>
  | OutputObjectDefinition<ReviewResult>;

/** The outputs a round's sessions end with, by step, whatever their names. */
const OUTPUTS: Readonly<
  Record<ImplementSpecRoundSession["step"], RoundOutput>
> = {
  implement: implement.outputs().implement,
  merge: merge.outputs().merge,
  review: review.outputs().review,
  "review-fixes": implement.outputs().implement,
};

/** The round's `Output` definitions, by session name. */
export const roundOutputs = (
  state: ImplementSpecState,
): Readonly<Record<string, RoundOutput>> =>
  Object.fromEntries(
    Object.entries(state.sessions).map(
      ([name, session]): [string, RoundOutput] => [name, OUTPUTS[session.step]],
    ),
  );

const ENDED_WELL = new Set(["completed", "closing-tag"]);

/** One session's outcome from its report entry, its output checked against `output`. */
const fromReport = async (
  output: RoundOutput | undefined,
  entry: FinishReport["data"]["sessions"][string] | undefined,
): Promise<SessionOutcome> => {
  if (entry === undefined || output === undefined) {
    return {
      ended: false,
      reason: "the session isn't in the round's report",
      timeLimit: false,
    };
  }
  if (!ENDED_WELL.has(entry.exitReason)) {
    return {
      ended: false,
      reason:
        `it ended ${entry.exitReason}: ${entry.finalMessage || entry.outputTail}`.trim(),
      timeLimit: entry.exitReason === "time-limit",
    };
  }
  const checked = await output.schema["~standard"].validate(entry.output);
  if (checked.issues !== undefined) {
    return {
      ended: false,
      reason: `its ${output.tag} didn't match: ${checked.issues.map((issue) => issue.message).join("; ")}`,
      timeLimit: false,
    };
  }
  return { ended: true, output: checked.value };
};

/** The round's outcomes, by session name, read from its finish report. */
export const reportOutcomes = async (
  state: ImplementSpecState,
  report: FinishReport,
): Promise<Record<string, SessionOutcome>> => {
  const outputs = roundOutputs(state);
  const entries = await Promise.all(
    Object.keys(state.sessions).map(
      async (name) =>
        [
          name,
          await fromReport(outputs[name], report.data.sessions[name]),
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
};

/** How one held session ended. */
const settle = async (
  spawned: ImplementSpecSessions[string],
): Promise<SessionOutcome> => {
  try {
    const done: { readonly output: RoundResult } = await spawned.wait();
    return { ended: true, output: done.output };
  } catch (error) {
    return {
      ended: false,
      reason: error instanceof Error ? error.message : String(error),
      timeLimit: false,
    };
  }
};

/** The round's outcomes, by session name, awaited on a held handle. */
export const heldOutcomes = async (
  sessions: ImplementSpecSessions,
): Promise<Record<string, SessionOutcome>> => {
  const entries = await Promise.all(
    Object.entries(sessions).map(
      async ([name, spawned]): Promise<[string, SessionOutcome]> => [
        name,
        await settle(spawned),
      ],
    ),
  );
  return Object.fromEntries(entries);
};
