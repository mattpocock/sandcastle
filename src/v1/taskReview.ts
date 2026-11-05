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
}

/** The `review` bundled task: reads a pull request cold with `code-review`, comments once, and returns a verdict. */
export interface ReviewTask {
  /** The task's name, and the name of its session in the finish report. */
  readonly name: "review";
  /** 30 minutes for the session; a 40-minute sandbox time limit leaves room for setup and the report. */
  readonly limits: TaskLimits;
  /** The `Output` definitions for `verifyFinishReport`, by session name. */
  readonly outputs: () => ReviewOutputs;
  /**
   * Clones `repo`, checks out the pull request's branch, installs the
   * `code-review` skill, runs `setup`, then spawns the `review` session
   * (Claude Code on Sonnet unless you pass `agent`) and resolves once it runs. The prompt gives the pull request's
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

/** Reviews a pull request cold and returns `reviewResult`. */
export const review: ReviewTask = {
  name: "review",
  limits: LIMITS,
  outputs: () => ({ review: REVIEW_RESULT }),
  start: async (sandbox, input) =>
    startTask(sandbox, {
      name: "review",
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
      skillsContext: input.skillsContext,
      setup: input.setup ?? [],
      record: input.record,
      completionTimeoutSeconds: input.completionTimeoutSeconds,
    }),
};
