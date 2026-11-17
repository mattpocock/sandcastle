import type {
  AgentProvider,
  SessionProcess,
  SessionRecordOptions,
} from "../v1.js";
import type { Chooser } from "./chooser.js";
import type { ImplementResult } from "./implementResult.js";
import type { TaskSkillsContext } from "./Task.js";
import type { MergeResult } from "./taskMergeResult.js";
import type { ReviewResult } from "./taskReviewResult.js";

// The types `implementSpec` takes and returns. Its state is plain JSON, with
// no secrets: the caller stores it between rounds and passes it back.

/** What `implementSpec.start`, `next` and `run` take. Pass the same input to every step. */
export interface ImplementSpecInput {
  /** The repo: `owner/name` on GitHub, or any URL or path `git clone` takes. */
  readonly repo: string;
  /** The spec, as a tracker reference: an issue number such as `671` on GitHub. */
  readonly spec: string;
  /**
   * A GitHub token that can read the spec and its tickets, write contents
   * and open pull requests. It reaches only the commands and sessions that
   * need it, never `state`: pass it again to every `next`.
   */
  readonly githubToken: string;
  /** The tracker the spec and its tickets live in; every session gets it. */
  readonly skillsContext: TaskSkillsContext;
  /** Commands run in each new clone, in order, before its session. */
  readonly setup?: readonly string[];
  /** Where every session's record goes when it ends. */
  readonly record?: SessionRecordOptions;
  /**
   * The agent every session runs, the chooser's too. Default each task's
   * own: Opus for `implement`, Sonnet for `merge`, Haiku for the default
   * chooser.
   */
  readonly agent?: AgentProvider;
  /** The most `implement` sessions a round runs at once. Default 3. */
  readonly maxConcurrent?: number;
  /** Picks the tickets to build next. Default `sessionChooser()`, on `agent` when given. */
  readonly chooser?: Chooser;
}

/**
 * Where a ticket has got to. `implementing` and `merging` while its round
 * runs, `to-merge` once its PR waits for its merge, `retrying` after a round
 * the deadline cut short (once only), then `merged` (or it needed no
 * changes), `stuck`, or `skipped` (a ticket it's blocked by is stuck).
 */
export type ImplementSpecTicketStatus =
  | "implementing"
  | "to-merge"
  | "merging"
  | "retrying"
  | "merged"
  | "stuck"
  | "skipped";

/** One ticket's progress. */
export interface ImplementSpecTicket {
  readonly status: ImplementSpecTicketStatus;
  /** The ticket's branch, once `implement` reported one. */
  readonly branch?: string;
  /** The ticket's PR into the integration branch, once opened. */
  readonly pr?: { readonly number: number; readonly url: string };
  /** What happened, or why it's stuck, in a few sentences. */
  readonly summary?: string;
  /** Whether its current step (`implement`, then `merge`) has used up its one retry after a deadline. */
  readonly retried: boolean;
}

/**
 * One session of the round just spawned: which step of which ticket. The
 * `review` of the integration PR and its `review-fixes` round work on the
 * whole spec, so their `ticket` is the spec.
 */
export interface ImplementSpecRoundSession {
  readonly step: "implement" | "merge" | "review" | "review-fixes";
  readonly ticket: string;
}

/** The integration PR, from the integration branch to the default branch. */
export interface ImplementSpecPullRequest {
  readonly number: number;
  readonly url: string;
}

/** The review of the integration PR, and whether its comments were addressed. */
export interface ImplementSpecReview {
  readonly verdict: ReviewResult["verdict"];
  /** Whether the `implement-review-fixes` round pushed fixes; always `false` on `approve`. */
  readonly fixed: boolean;
}

/** `implementSpec`'s progress: plain JSON, with no token. Store it between steps. */
export interface ImplementSpecState {
  /** The spec. */
  readonly spec: string;
  /** The integration branch every ticket merges into: `sandcastle/implement-spec-<spec>-<random>`. */
  readonly branch: string;
  /** How many rounds have been spawned. */
  readonly round: number;
  /** How many times the chooser has run. */
  readonly choices: number;
  /** The last round's sessions, by name. Empty once done. */
  readonly sessions: Readonly<Record<string, ImplementSpecRoundSession>>;
  /** Every ticket started so far, by its reference. */
  readonly tickets: Readonly<Record<string, ImplementSpecTicket>>;
  /** Tickets whose PRs wait to merge, in order. Merges run one per round. */
  readonly merges: readonly string[];
  /** Set once the chooser said the spec is blocked. */
  readonly blocked?: string;
  /** The integration PR, once opened. */
  readonly pr?: ImplementSpecPullRequest;
  /** The review's verdict, once it ended. */
  readonly review?: ImplementSpecReview;
  /** Why the review or its fix round didn't finish, when one didn't. */
  readonly reviewProblem?: string;
  /** Whether the work is over; `next` rejects then. */
  readonly done: boolean;
}

/** How a spec ended up. */
export interface ImplementSpecResult {
  /**
   * `complete`: every ticket merged. `partial`: some merged, some stuck or
   * skipped. `blocked`: the chooser said blocked, or nothing could merge.
   */
  readonly status: "complete" | "partial" | "blocked";
  /** The integration branch. */
  readonly branch: string;
  /**
   * The integration branch's PR against the default branch, left open for a
   * human to merge. Absent when nothing merged, the chooser said blocked, or
   * no merged ticket changed anything.
   */
  readonly pr?: ImplementSpecPullRequest;
  /** The `review` of that PR, when it ended with a verdict. */
  readonly review?: ImplementSpecReview;
  /** The tickets merged into it, or that needed no changes. */
  readonly merged: readonly string[];
  /** The tickets that couldn't be finished, and why. */
  readonly stuck: readonly {
    readonly ticket: string;
    readonly reason: string;
  }[];
  /** The tickets left out because a ticket they're blocked by is stuck. */
  readonly skipped: readonly string[];
  /** The outcome, in a sentence or two. */
  readonly summary: string;
}

/** A round's sessions, by name: `implement-<ticket>`, `merge-<ticket>`, `review` or `implement-review-fixes`. */
export type ImplementSpecSessions = Readonly<
  Record<
    string,
    | SessionProcess<ImplementResult>
    | SessionProcess<MergeResult>
    | SessionProcess<ReviewResult>
  >
>;

/** What `start` and `next` resolve with: the round they spawned, or the end. */
export type ImplementSpecStep =
  | {
      readonly done: false;
      readonly state: ImplementSpecState;
      readonly sessions: ImplementSpecSessions;
    }
  | {
      readonly done: true;
      readonly state: ImplementSpecState;
      readonly result: ImplementSpecResult;
    };
