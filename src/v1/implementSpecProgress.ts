import type { ImplementResult } from "./implementResult.js";
import type {
  ImplementSpecResult,
  ImplementSpecReview,
  ImplementSpecRoundSession,
  ImplementSpecState,
  ImplementSpecTicket,
} from "./implementSpecTypes.js";
import type { MergeResult } from "./taskMergeResult.js";
import type { ReviewResult } from "./taskReviewResult.js";

// What a round's results do to `implementSpec`'s state, and the result read
// from it at the end. Pure: no sandbox, no I/O.

/** What one of the round's sessions can end with. */
export type RoundResult = ImplementResult | MergeResult | ReviewResult;

/** How one of the round's sessions ended. */
export type SessionOutcome =
  | { readonly ended: true; readonly output: RoundResult }
  | {
      readonly ended: false;
      readonly reason: string;
      /** The detach deadline stopped it: worth one retry. */
      readonly timeLimit: boolean;
    };

/** A round that ended: the state that spawned it, and how each session ended, by name. */
export interface RoundEnd {
  readonly state: ImplementSpecState;
  readonly outcomes: Readonly<Record<string, SessionOutcome>>;
}

type Tickets = Record<string, ImplementSpecTicket>;

export const isImplementResult = (
  output: RoundResult,
): output is ImplementResult => "branch" in output;

const isMergeResult = (output: RoundResult): output is MergeResult =>
  "into" in output;

/** A ticket after its `implement` session ended with `output`; its merge gets a retry of its own. */
const implemented = (output: ImplementResult): ImplementSpecTicket => {
  const base = {
    branch: output.branch,
    summary: output.summary,
    retried: false,
    ...(output.pr === undefined ? {} : { pr: output.pr }),
  };
  switch (output.status) {
    case "pr-opened":
    case "pr-updated": {
      return { ...base, status: "to-merge" };
    }
    case "no-changes": {
      return { ...base, status: "merged" };
    }
    case "blocked": {
      return { ...base, status: "stuck" };
    }
  }
};

/**
 * A ticket after its `merge` session ended with `output`. A landed merge
 * keeps the implement summary, which says what the ticket built, and records
 * its own beside it; a failed one says why in `summary`.
 */
const merged = (
  ticket: ImplementSpecTicket,
  output: MergeResult,
): ImplementSpecTicket =>
  output.status === "merged"
    ? {
        ...ticket,
        status: "merged",
        merge: {
          summary: output.summary,
          ...(output.commit === undefined ? {} : { commit: output.commit }),
        },
      }
    : {
        ...ticket,
        status: "stuck",
        summary: `the merge ended ${output.status}: ${output.summary}`,
      };

/** A ticket whose session failed: retried once after a deadline, else stuck. */
const failed = (
  ticket: ImplementSpecTicket,
  session: ImplementSpecRoundSession,
  outcome: { readonly reason: string; readonly timeLimit: boolean },
): ImplementSpecTicket => {
  const retry = outcome.timeLimit && !ticket.retried;
  if (!retry) {
    return {
      ...ticket,
      status: "stuck",
      summary: `${session.step} failed: ${outcome.reason}`,
    };
  }
  return {
    ...ticket,
    status: session.step === "merge" ? "to-merge" : "retrying",
    retried: true,
  };
};

const MISSING: SessionOutcome = {
  ended: false,
  reason: "the session isn't in the round's report",
  timeLimit: false,
};

/** One session's ticket after it ended with `outcome`. */
const afterSession = (
  ticket: ImplementSpecTicket,
  session: ImplementSpecRoundSession,
  outcome: SessionOutcome,
): ImplementSpecTicket => {
  if (!outcome.ended) {
    return failed(ticket, session, outcome);
  }
  const { output } = outcome;
  if (session.step === "implement" && isImplementResult(output)) {
    return implemented(output);
  }
  if (session.step === "merge" && isMergeResult(output)) {
    return merged(ticket, output);
  }
  return failed(ticket, session, {
    reason: `the session ended with another task's output`,
    timeLimit: false,
  });
};

/**
 * The state once the round's sessions ended with `outcomes`, by name. A
 * session missing from them failed. Tickets whose PRs opened queue up to
 * merge in the round's order; a merge cut short by the deadline goes first.
 */
export const applyOutcomes = (
  state: ImplementSpecState,
  outcomes: Readonly<Record<string, SessionOutcome>>,
): ImplementSpecState => {
  const tickets: Tickets = { ...state.tickets };
  const merges = [...state.merges];
  const retriedMerges: string[] = [];
  for (const [name, session] of Object.entries(state.sessions)) {
    const before = tickets[session.ticket] ?? {
      status: "implementing",
      retried: false,
    };
    const after = afterSession(before, session, outcomes[name] ?? MISSING);
    tickets[session.ticket] = after;
    if (after.status === "to-merge") {
      (session.step === "merge" ? retriedMerges : merges).push(session.ticket);
    }
  }
  return {
    ...state,
    sessions: {},
    tickets,
    merges: [...retriedMerges, ...merges],
  };
};

/** The tickets with `status`, in the order they were started. */
export const ticketsWith = (
  state: ImplementSpecState,
  status: ImplementSpecTicket["status"],
): string[] =>
  Object.entries(state.tickets)
    .filter(([, ticket]) => ticket.status === status)
    .map(([reference]) => reference);

const statusOf = (
  state: ImplementSpecState,
  mergedCount: number,
  left: number,
): ImplementSpecResult["status"] => {
  if (state.blocked !== undefined || (mergedCount === 0 && left > 0)) {
    return "blocked";
  }
  return left > 0 ? "partial" : "complete";
};

/** The review's outcome, in a sentence. */
const reviewLine = (review: ImplementSpecReview | undefined): string => {
  if (review === undefined) {
    return "";
  }
  if (review.verdict === "approve") {
    return " Its review approved it.";
  }
  return review.fixed
    ? " Its review requested changes, and implement-review-fixes pushed them."
    : " Its review requested changes, which weren't fixed.";
};

/** What happened after the merges, in a sentence or two: the PR, its review and the fix. */
const endOf = (state: ImplementSpecState): string => {
  if (state.pr === undefined) {
    return "";
  }
  const problem =
    state.reviewProblem === undefined ? "" : ` ${state.reviewProblem}`;
  return ` Opened PR #${state.pr.number} (${state.pr.url}), left for a human to merge.${reviewLine(state.review)}${problem}`;
};

/** What the spec came to, read from its final state. */
export const resultOf = (state: ImplementSpecState): ImplementSpecResult => {
  const mergedTickets = ticketsWith(state, "merged");
  const stuck = ticketsWith(state, "stuck").map((ticket) => ({
    ticket,
    reason: state.tickets[ticket]?.summary ?? "unknown",
  }));
  const skipped = ticketsWith(state, "skipped");
  const left = stuck.length + skipped.length;
  const status = statusOf(state, mergedTickets.length, left);
  const counts = `${mergedTickets.length} merged into ${state.branch}, ${stuck.length} stuck, ${skipped.length} skipped`;
  return {
    status,
    branch: state.branch,
    ...(state.pr === undefined ? {} : { pr: state.pr }),
    ...(state.review === undefined ? {} : { review: state.review }),
    merged: mergedTickets,
    stuck,
    skipped,
    summary:
      state.blocked === undefined
        ? `Spec ${state.spec}: ${counts}.${endOf(state)}`
        : `Spec ${state.spec} is blocked: ${state.blocked} (${counts}).`,
  };
};
