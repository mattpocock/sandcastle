import type { Sandbox } from "../v1.js";
import {
  checkRoom,
  common,
  finished,
  messageOf,
} from "./implementSpecCommon.js";
import type {
  RoundEnd,
  RoundResult,
  SessionOutcome,
} from "./implementSpecProgress.js";
import { isImplementResult, ticketsWith } from "./implementSpecProgress.js";
import { openIntegrationPr } from "./implementSpecPullRequest.js";
import type {
  ImplementSpecInput,
  ImplementSpecSessions,
  ImplementSpecState,
  ImplementSpecStep,
} from "./implementSpecTypes.js";
import { implement } from "./taskImplement.js";
import { review } from "./taskReview.js";
import type { ReviewResult } from "./taskReviewResult.js";

// The end of `implementSpec`, once the chooser has nothing left: the
// integration PR, one `review` session on it, and after `changes-requested`
// one `implement` round 2 on the integration branch. There's no second
// review, and the PR is never merged.

/** The review round's session name. */
const REVIEW = "review";

/** The fix round's session name. */
const FIXES = "implement-review-fixes";

/** Whether the round `state` spawned is the review or its fix round. */
export const isReviewRound = (state: ImplementSpecState): boolean =>
  Object.values(state.sessions).some(
    (session) => session.step === "review" || session.step === "review-fixes",
  );

/** The one session a review or fix round spawned. */
interface Spawned {
  readonly name: string;
  readonly step: "review" | "review-fixes";
  readonly spawned: ImplementSpecSessions[string];
}

/** A step with one session spawned as the next round. */
const oneSession = (
  state: ImplementSpecState,
  { name, step, spawned }: Spawned,
): ImplementSpecStep => ({
  done: false,
  state: {
    ...state,
    round: state.round + 1,
    sessions: { [name]: { step, ticket: state.spec } },
  },
  sessions: { [name]: spawned },
});

/**
 * Once no ticket is left: opens the integration PR and spawns its `review`,
 * or ends when there's nothing to put up (the chooser said blocked, nothing
 * merged, or no merged ticket changed anything).
 */
export const integrate = async (
  sandbox: Sandbox,
  input: ImplementSpecInput,
  state: ImplementSpecState,
): Promise<ImplementSpecStep> => {
  if (
    state.blocked !== undefined ||
    ticketsWith(state, "merged").length === 0
  ) {
    return finished(state);
  }
  const pr = await openIntegrationPr(sandbox, {
    state,
    githubToken: input.githubToken,
  });
  if (pr === undefined) {
    return finished(state);
  }
  const opened = { ...state, pr };
  try {
    const spawned = await review.start(sandbox, {
      ...common(input),
      name: REVIEW,
      pr: pr.number,
    });
    return oneSession(opened, {
      name: REVIEW,
      step: "review",
      spawned,
    });
  } catch (error) {
    return finished({
      ...opened,
      reviewProblem: `The review couldn't start: ${messageOf(error)}`,
    });
  }
};

/** Spawns the one fix round for a `changes-requested` review, with its comments. */
const fixRound = async (
  sandbox: Sandbox,
  input: ImplementSpecInput,
  {
    state,
    comments,
  }: {
    readonly state: ImplementSpecState;
    readonly comments: readonly string[];
  },
): Promise<ImplementSpecStep> => {
  const reviewed = {
    ...state,
    review: { verdict: "changes-requested", fixed: false },
  } as const;
  checkRoom(sandbox);
  try {
    const spawned = await implement.start(sandbox, {
      ...common(input),
      name: FIXES,
      ticket: input.spec,
      branch: state.branch,
      feedback: comments,
    });
    return oneSession(reviewed, {
      name: FIXES,
      step: "review-fixes",
      spawned,
    });
  } catch (error) {
    return finished({
      ...reviewed,
      reviewProblem: `The fix round couldn't start: ${messageOf(error)}`,
    });
  }
};

/** Why a session's outcome isn't the output its step ends with. */
const failure = (outcome: SessionOutcome): string =>
  outcome.ended ? "it ended with another task's output" : outcome.reason;

/** The end once the fix round ended with `outcome`. */
const afterFixes = (
  state: ImplementSpecState,
  outcome: SessionOutcome,
): ImplementSpecStep => {
  const verdict = { verdict: "changes-requested", fixed: false } as const;
  if (!outcome.ended || !isImplementResult(outcome.output)) {
    return finished({
      ...state,
      review: verdict,
      reviewProblem: `The fix round failed: ${failure(outcome)}`,
    });
  }
  const { status, summary } = outcome.output;
  const fixed = status === "pr-opened" || status === "pr-updated";
  return finished({
    ...state,
    review: { ...verdict, fixed },
    ...(fixed
      ? {}
      : { reviewProblem: `The fix round ended ${status}: ${summary}` }),
  });
};

const isReviewResult = (output: RoundResult): output is ReviewResult =>
  "verdict" in output;

const MISSING: SessionOutcome = {
  ended: false,
  reason: "the session isn't in the round's report",
  timeLimit: false,
};

/**
 * Acts on the review round, or its fix round, once it ended:
 * `changes-requested` spawns the one fix round; anything else is the end.
 */
export const afterReview = async (
  sandbox: Sandbox,
  input: ImplementSpecInput,
  { state, outcomes }: RoundEnd,
): Promise<ImplementSpecStep> => {
  const [name = "", session] = Object.entries(state.sessions)[0] ?? [];
  const outcome = outcomes[name] ?? MISSING;
  const ended = { ...state, sessions: {} };
  if (session?.step === "review-fixes") {
    return afterFixes(ended, outcome);
  }
  if (!outcome.ended || !isReviewResult(outcome.output)) {
    return finished({
      ...ended,
      reviewProblem: `The review failed: ${failure(outcome)}`,
    });
  }
  if (outcome.output.verdict === "approve") {
    return finished({ ...ended, review: { verdict: "approve", fixed: false } });
  }
  return fixRound(sandbox, input, {
    state: ended,
    comments: outcome.output.comments,
  });
};
