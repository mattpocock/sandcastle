import { claudeCode } from "./agents.js";
import type { Sandbox } from "./Sandbox.js";
import type { SessionProcess } from "./Session.js";
import type { SessionRecordOptions } from "./SessionRecord.js";
import { codeReview } from "./skills/codeReview.js";
import type {
  TaskAgentOptions,
  TaskLimits,
  TaskSkillsContext,
} from "./Task.js";
import { checkOutPullRequest } from "./taskPullRequest.js";
import type { ReviewOutputs, ReviewResult } from "./taskReviewResult.js";
import { REVIEW_RESULT } from "./taskReviewResult.js";
import { reviewPrompt } from "./taskReviewPrompt.js";
import { startTask } from "./taskStart.js";

/** What `review.start` takes. */
export interface ReviewInput extends TaskAgentOptions {
  /** The pull request's repo: `owner/name` on GitHub, or a URL `git clone` takes. */
  readonly repo: string;
  /** The pull request's number. */
  readonly pr: number;
  /**
   * A GitHub token that can read the repo's contents and write pull request
   * comments. It reaches only the clone, the pull request checkout and the
   * session, as `GH_TOKEN`.
   */
  readonly githubToken: string;
  /** The tracker the linked ticket is read from. */
  readonly skillsContext: TaskSkillsContext;
  /** Commands run in the clone, on the pull request's branch, before the session; the first failure rejects. */
  readonly setup?: readonly string[];
  /** Where the session's record goes when it ends. */
  readonly record?: SessionRecordOptions;
  /**
   * The session's name, its record's and its key in the finish report.
   * Default `"review"`. Give each of several tasks on one handle its own: a
   * start rejects a name already running before it clones anything. A name
   * other than `"review"` is also the directory the repo is cloned into, so it
   * must be letters, digits, `_`, `.` and `-`, not starting with `.` or `-`.
   */
  readonly name?: string;
}

/** The `review` bundled task: reads a pull request cold with `code-review`, comments once, and returns a verdict. */
export interface ReviewTask {
  /** The task's name, and its session's unless you pass `name`. */
  readonly name: "review";
  /** 30 minutes for the session; a 40-minute sandbox time limit leaves room for setup and the report. */
  readonly limits: TaskLimits;
  /** The `Output` definitions for `verifyFinishReport`, under the session's name (`"review"` when left out). */
  readonly outputs: {
    (): ReviewOutputs;
    <Name extends string>(name: Name): ReviewOutputs<Name>;
  };
  /**
   * Rejects a `name` already running on the handle, or a sandbox with no
   * `gh` on its PATH, before it clones anything. Then clones `repo`, checks out the pull request's branch, installs the
   * `code-review` skill, runs `setup`, then spawns the session (named
   * `name`, default `"review"`; Claude Code on Sonnet unless you pass `agent`) and resolves once it runs. The prompt gives the pull request's
   * base as the fixed point and the tickets it closes as the spec (or says
   * there is none). The session posts one pull request comment and never
   * approves or merges. Rejects when the sandbox's kill time leaves less
   * room than `limits.deadlineMinutes`.
   */
  readonly start: (
    sandbox: Sandbox,
    input: ReviewInput,
  ) => Promise<SessionProcess<ReviewResult>>;
}

const LIMITS: TaskLimits = { timeLimitMinutes: 40, deadlineMinutes: 30 };

function outputs(): ReviewOutputs;
function outputs<Name extends string>(name: Name): ReviewOutputs<Name>;
function outputs(name = "review"): ReviewOutputs<string> {
  return { [name]: REVIEW_RESULT };
}

/** Reviews a pull request cold and returns `reviewResult`. */
export const review: ReviewTask = {
  name: "review",
  limits: LIMITS,
  outputs,
  start: async (sandbox, input) =>
    startTask(sandbox, {
      name: "review",
      session: input.name,
      limits: LIMITS,
      agent: input.agent ?? claudeCode("sonnet"),
      skills: [codeReview],
      prompt: async (clone) =>
        reviewPrompt(
          input.pr,
          await checkOutPullRequest(sandbox, {
            pr: input.pr,
            clone,
            githubToken: input.githubToken,
          }),
        ),
      output: REVIEW_RESULT,
      repo: input.repo,
      branch: undefined,
      githubToken: input.githubToken,
      gh: "it reads the pull request, and the agent posts the review, with the GitHub CLI",
      skillsContext: input.skillsContext,
      setup: input.setup ?? [],
      record: input.record,
      completionTimeoutSeconds: input.completionTimeoutSeconds,
    }),
};
