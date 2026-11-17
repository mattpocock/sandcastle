import { claudeCode } from "./agents.js";
import type { Sandbox } from "./Sandbox.js";
import type { SessionProcess } from "./Session.js";
import type { SessionRecordOptions } from "./SessionRecord.js";
import type {
  TaskAgentOptions,
  TaskLimits,
  TaskSkillsContext,
} from "./Task.js";
import {
  checkMergeBranches,
  prepareMerge,
  refuseDefaultBranch,
} from "./taskMergePrepare.js";
import { mergePrompt } from "./taskMergePrompt.js";
import type { MergeOutputs, MergeResult } from "./taskMergeResult.js";
import { MERGE_RESULT } from "./taskMergeResult.js";
import { startTask } from "./taskStart.js";

/** What `merge.start` takes. */
export interface MergeInput extends TaskAgentOptions {
  /** The repo: `owner/name` on GitHub, or any URL or path `git clone` takes. */
  readonly repo: string;
  /**
   * What to merge: a branch on `origin`, or a pull request's number, whose
   * head is merged (fetched as `review` checks it out). A pull request
   * merged into its own base branch this way shows as merged on GitHub.
   */
  readonly from: string | number;
  /** The branch to merge into, on `origin`. Never the repo's default branch: `start` rejects it before cloning. */
  readonly into: string;
  /**
   * A GitHub token that can write the repo's contents (and read its pull
   * requests, when `from` is one). It reaches only the commands that read
   * the remote and the session, as `GH_TOKEN`; the session uses it to push.
   */
  readonly githubToken: string;
  /** The tracker, rendered into the prompt like every bundled task's. */
  readonly skillsContext: TaskSkillsContext;
  /** Commands run in the clone, in order, before the session; the first failure rejects. */
  readonly setup?: readonly string[];
  /** Where the session's record goes when it ends. */
  readonly record?: SessionRecordOptions;
  /** The session's name, and its key in the finish report. Default `"merge"`. */
  readonly name?: string;
}

/** The `merge` bundled task: one branch merged into another with a merge commit, checked and pushed. */
export interface MergeTask {
  /** The task's name, and its session's unless you pass `name`. */
  readonly name: "merge";
  /** 30 minutes for the session; a 40-minute sandbox time limit leaves room for setup and the report. */
  readonly limits: TaskLimits;
  /** The `Output` definitions for `verifyFinishReport`, under the session's name (`"merge"` when left out). */
  readonly outputs: {
    (): MergeOutputs;
    <Name extends string>(name: Name): MergeOutputs<Name>;
  };
  /**
   * Rejects `into` = the repo's default branch before it clones anything.
   * Then clones `repo`, checks out `into`, finds `from` and tries the merge
   * with a merge commit: a clean one stays committed, a conflicted one is
   * aborted and left to the agent. Runs `setup`, spawns the session (Claude
   * Code on Sonnet unless you pass `agent`; no skills) and resolves once it
   * runs. The agent resolves any conflicts keeping both sides' intent, runs
   * the repo's checks, and pushes `into`, never force-pushing. Rejects when
   * the sandbox's kill time leaves less room than `limits.deadlineMinutes`.
   */
  readonly start: (
    sandbox: Sandbox,
    input: MergeInput,
  ) => Promise<SessionProcess<MergeResult>>;
}

const LIMITS: TaskLimits = { timeLimitMinutes: 40, deadlineMinutes: 30 };

const start: MergeTask["start"] = async (sandbox, input) => {
  const { from } = input;
  checkMergeBranches(from, input.into);
  await refuseDefaultBranch(sandbox, input);
  return startTask(sandbox, {
    name: input.name ?? "merge",
    limits: LIMITS,
    agent: input.agent ?? claudeCode("sonnet"),
    skills: [],
    prompt: async (clone) =>
      mergePrompt({
        merge: await prepareMerge(sandbox, {
          clone,
          from,
          into: input.into,
          githubToken: input.githubToken,
        }),
        into: input.into,
        setup: input.setup ?? [],
      }),
    output: MERGE_RESULT,
    repo: input.repo,
    branch: { name: input.into, create: false, from: undefined },
    githubToken: input.githubToken,
    skillsContext: input.skillsContext,
    setup: input.setup ?? [],
    record: input.record,
    completionTimeoutSeconds: input.completionTimeoutSeconds,
  });
};

function outputs(): MergeOutputs;
function outputs<Name extends string>(name: Name): MergeOutputs<Name>;
function outputs(name = "merge"): MergeOutputs<string> {
  return { [name]: MERGE_RESULT };
}

/** Merges a branch or pull request into another branch and pushes it; never into the default branch. */
export const merge: MergeTask = {
  name: "merge",
  limits: LIMITS,
  outputs,
  start,
};
