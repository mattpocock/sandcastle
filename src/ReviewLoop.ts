import { z } from "zod";
import { extractStructuredOutput } from "./extractStructuredOutput.js";
import { Output } from "./Output.js";

/** XML tag carrying the reviewer's structured verdict. */
export const REVIEW_VERDICT_TAG = "review-verdict";
const COMPLETE = "<promise>COMPLETE</promise>";
const BLOCKED = "<promise>BLOCKED</promise>";

/** One required change reported by the reviewer. */
export const reviewFindingSchema = z
  .object({
    /** Stable identifier, unique within one verdict. */
    id: z.string().min(1).max(80),
    severity: z.enum(["critical", "major", "minor"]),
    /** Repository-relative path, when the finding is file-specific. */
    file: z.string().min(1).max(500).optional(),
    line: z.number().int().positive().optional(),
    /** The change the implementer must make. */
    change: z.string().min(1).max(4000),
  })
  .strict();
/** Structured reviewer verdict. */
export const reviewVerdictSchema = z
  .object({
    verdict: z.enum(["approve", "changes-requested", "blocked"]),
    /** One-paragraph summary for logs and Agent Map. */
    summary: z.string().max(2000).optional(),
    findings: z.array(reviewFindingSchema).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.verdict === "changes-requested" && value.findings.length === 0)
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "changes-requested requires at least one finding",
      });
    if (
      value.verdict === "approve" &&
      value.findings.some((finding) => finding.severity !== "minor")
    )
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "approve may carry only minor findings",
      });
    const ids = value.findings.map((finding) => finding.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "finding ids must be unique",
      });
  });
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
const verdictOutput = Output.object({
  tag: REVIEW_VERDICT_TAG,
  schema: reviewVerdictSchema,
});

/** Minimal run shape the loop needs from `sandbox.run()` / `run()`. */
export interface ReviewLoopRun {
  readonly stdout: string;
  readonly commits: readonly { readonly sha: string }[];
  readonly completionSignal?: string;
}

/** Parse the last `<review-verdict>` in reviewer output; throws on missing or invalid output. */
export const parseReviewVerdict = (stdout: string): Promise<ReviewVerdict> =>
  extractStructuredOutput<ReviewVerdict>(stdout, verdictOutput, {
    commits: [],
    branch: "",
  });

/** Render findings as the implementer's repair input (prompt argument). */
export const formatReviewFindings = (
  findings: readonly ReviewFinding[],
): string =>
  findings
    .map(
      (finding) =>
        `- [${finding.id}] (${finding.severity})${finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""}: ${finding.change}`,
    )
    .join("\n");

/** Record of one review round. */
export interface ReviewRound {
  readonly round: number;
  readonly verdict: ReviewVerdict["verdict"] | "invalid";
  readonly summary?: string;
  readonly findings: readonly ReviewFinding[];
  /** Validation message when the reviewer output was malformed. */
  readonly error?: string;
  /** True when the implementer ran a repair after this round. */
  readonly repaired: boolean;
}

export interface ReviewLoopOptions<R extends ReviewLoopRun> {
  /**
   * Repair rounds allowed after a `changes-requested` verdict. Default 2.
   * `0` restores single-pass review: the reviewer may repair in place and a
   * `<promise>COMPLETE</promise>` without a verdict is accepted.
   */
  readonly maxRepairRounds?: number;
  /** Run the reviewer for a one-based round. */
  review(round: number): Promise<R>;
  /** Run the implementer with the previous round's findings. */
  repair(findings: readonly ReviewFinding[], round: number): Promise<R>;
}

export interface ReviewLoopResult<R extends ReviewLoopRun> {
  /** Only `approved` admits the branch to merge. */
  readonly outcome:
    | "approved"
    | "changes-requested"
    | "blocked"
    | "invalid-review";
  readonly rounds: readonly ReviewRound[];
  /** Findings of the last round (empty when approved without findings). */
  readonly findings: readonly ReviewFinding[];
  /** Commits made by every review and repair run, in order. */
  readonly commits: readonly { readonly sha: string }[];
  /** The last review or repair run. */
  readonly last: R;
}

/**
 * Bounded review→repair loop. The reviewer returns a structured verdict; on
 * `changes-requested` the implementer repairs the findings and the reviewer
 * re-checks, up to `maxRepairRounds`. Malformed reviewer output fails closed.
 */
export const runReviewLoop = async <R extends ReviewLoopRun>(
  options: ReviewLoopOptions<R>,
): Promise<ReviewLoopResult<R>> => {
  const maxRepairRounds = options.maxRepairRounds ?? 2;
  if (!Number.isInteger(maxRepairRounds) || maxRepairRounds < 0)
    throw new RangeError("maxRepairRounds must be a non-negative integer");
  const rounds: ReviewRound[] = [];
  const commits: { sha: string }[] = [];
  const finish = (
    outcome: ReviewLoopResult<R>["outcome"],
    last: R,
  ): ReviewLoopResult<R> => ({
    outcome,
    rounds,
    findings: rounds.at(-1)?.findings ?? [],
    commits,
    last,
  });
  for (let round = 1; ; round++) {
    const review = await options.review(round);
    commits.push(...review.commits);
    const signal = review.completionSignal ?? "";
    let verdict: ReviewVerdict;
    try {
      verdict = await parseReviewVerdict(review.stdout);
    } catch (error) {
      if (maxRepairRounds === 0 && signal.includes(COMPLETE)) {
        rounds.push({
          round,
          verdict: "approve",
          findings: [],
          repaired: false,
        });
        return finish("approved", review);
      }
      rounds.push({
        round,
        verdict: "invalid",
        findings: [],
        error: error instanceof Error ? error.message : String(error),
        repaired: false,
      });
      return finish(
        signal.includes(BLOCKED) ? "blocked" : "invalid-review",
        review,
      );
    }
    const base = {
      round,
      verdict: verdict.verdict,
      ...(verdict.summary === undefined ? {} : { summary: verdict.summary }),
      findings: verdict.findings,
    };
    if (verdict.verdict === "blocked" || signal.includes(BLOCKED)) {
      rounds.push({ ...base, repaired: false });
      return finish("blocked", review);
    }
    if (verdict.verdict === "approve") {
      rounds.push({ ...base, repaired: false });
      // An approval must also end with the completion signal.
      return finish(
        signal.includes(COMPLETE) ? "approved" : "invalid-review",
        review,
      );
    }
    if (round > maxRepairRounds) {
      rounds.push({ ...base, repaired: false });
      return finish("changes-requested", review);
    }
    rounds.push({ ...base, repaired: true });
    const repair = await options.repair(verdict.findings, round);
    commits.push(...repair.commits);
    if ((repair.completionSignal ?? "").includes(BLOCKED))
      return finish("blocked", repair);
  }
};

/** Review summary attached to a reviewer run for Agent Map and run evidence. */
export interface ReviewRunEvidence {
  readonly verdict: ReviewVerdict["verdict"] | "invalid";
  readonly summary?: string;
  readonly findings: readonly ReviewFinding[];
  readonly error?: string;
}

/**
 * Attach the parsed verdict to a reviewer run as `review`, so Agent Map can
 * show the verdict and findings. Never throws; malformed output is recorded
 * as `invalid`.
 */
export const withReviewVerdict = async <R extends ReviewLoopRun>(
  run: R | Promise<R>,
): Promise<R & { review: ReviewRunEvidence }> => {
  const value = await run;
  try {
    const verdict = await parseReviewVerdict(value.stdout);
    return {
      ...value,
      review: {
        verdict: verdict.verdict,
        ...(verdict.summary === undefined ? {} : { summary: verdict.summary }),
        findings: verdict.findings,
      },
    };
  } catch (error) {
    return {
      ...value,
      review: {
        verdict: "invalid",
        findings: [],
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
};
