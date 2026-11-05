import { randomUUID } from "node:crypto";
import { claudeCode } from "./agents.js";
import type { ImplementOutputs, ImplementResult } from "./implementResult.js";
import { IMPLEMENT_RESULT } from "./implementResult.js";
import type { Sandbox } from "./Sandbox.js";
import type { SessionProcess } from "./Session.js";
import type { SessionRecordOptions } from "./SessionRecord.js";
import { MIRRORED_SKILLS } from "./skills/mirroredSkills.js";
import type {
  TaskAgentOptions,
  TaskLimits,
  TaskSkillsContext,
} from "./Task.js";
import { implementPrompt } from "./taskImplementPrompt.js";
import { startTask } from "./taskStart.js";

/** What every `implement` round takes. */
export interface ImplementCommon extends TaskAgentOptions {
  /** The repo to clone: `owner/name` on GitHub, or any URL or path `git clone` takes. */
  readonly repo: string;
  /**
   * A GitHub token that can write contents and pull requests. It reaches
   * only the clone command and the session, as `GH_TOKEN`; the session uses
   * it to push and to open the PR with `gh`.
   */
  readonly githubToken: string;
  /** The tracker the ticket is fetched from; it's rendered into the skills and the prompt. */
  readonly skillsContext: TaskSkillsContext;
  /** Commands run in the clone, in order, before the session; the first failure rejects. */
  readonly setup?: readonly string[];
  /** Where the session's record goes when it ends. */
  readonly record?: SessionRecordOptions;
}

/** The work: a ticket reference, or a prompt in your words. Exactly one. */
export type ImplementWork =
  | {
      /** The ticket to implement, as the tracker names it, e.g. `42`. */
      readonly ticket: string;
      readonly prompt?: never;
    }
  | {
      /** The work, in your words, when there's no ticket. */
      readonly prompt: string;
      readonly ticket?: never;
    };

/** A first round on a new branch, or a later round on an existing one. */
export type ImplementRound =
  | {
      /** Leave it out to create a new branch from the default branch. */
      readonly branch?: undefined;
      readonly feedback?: never;
    }
  | {
      /** An existing branch to work on, e.g. the one round 1 reported. */
      readonly branch: string;
      /**
       * The review's comments, for round 2: pass `ReviewResult.comments` as
       * it is, or your own text. The session is a fresh one on `branch`,
       * with these in its prompt; nothing is resumed.
       */
      readonly feedback?: string | readonly string[];
    };

/** What `implement.start` takes. */
export type ImplementInput = ImplementCommon & ImplementWork & ImplementRound;

/** The `implement` bundled task: a ticket in, a PR out, never merged. Claude Code on Opus unless you pass `agent`. */
export interface ImplementTask {
  /** The task's name, and the name of its session in the finish report. */
  readonly name: "implement";
  /** 90 minutes for the session; a 100-minute sandbox time limit leaves room for setup and the report. */
  readonly limits: TaskLimits;
  /** The `Output` definitions for `verifyFinishReport`, by session name. */
  readonly outputs: () => ImplementOutputs;
  /**
   * Clones `repo`, creates a branch from the default branch (or checks out
   * `branch`), installs the `implement`, `tdd`, `codebase-design`,
   * `code-review` and `pr` skills, runs `setup`, then spawns the `implement`
   * session and resolves once it runs. The prompt starts with `/implement`
   * and the ticket (or your prompt), and asks the agent to push and open or
   * update a PR, never merging it. Rejects when the sandbox's kill time
   * leaves less room than `limits.deadlineMinutes`.
   */
  readonly start: (
    sandbox: Sandbox,
    input: ImplementInput,
  ) => Promise<SessionProcess<ImplementResult>>;
}

const LIMITS: TaskLimits = { timeLimitMinutes: 100, deadlineMinutes: 90 };

const SKILLS = Object.values(MIRRORED_SKILLS);

/** A new branch's name: `sandcastle/implement-<ticket>-<random>`. */
const newBranchName = (input: ImplementInput): string => {
  const id = randomUUID().slice(0, 8);
  const ticket =
    input.ticket === undefined
      ? ""
      : input.ticket
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/gu, "-")
          .replaceAll(/^-+|-+$/gu, "");
  return ticket === ""
    ? `sandcastle/implement-${id}`
    : `sandcastle/implement-${ticket}-${id}`;
};

const start: ImplementTask["start"] = async (sandbox, input) => {
  const branch = input.branch ?? newBranchName(input);
  return startTask(sandbox, {
    name: "implement",
    limits: LIMITS,
    agent: input.agent ?? claudeCode("opus"),
    skills: SKILLS,
    prompt: implementPrompt({
      work:
        input.ticket === undefined
          ? { prompt: input.prompt }
          : { ticket: input.ticket },
      branch,
      newBranch: input.branch === undefined,
      feedback: input.feedback,
    }),
    output: IMPLEMENT_RESULT,
    repo: input.repo,
    branch: { name: branch, create: input.branch === undefined },
    githubToken: input.githubToken,
    skillsContext: input.skillsContext,
    setup: input.setup ?? [],
    record: input.record,
    completionTimeoutSeconds: input.completionTimeoutSeconds,
  });
};

/** Implements a ticket on a branch and opens or updates its PR; never merges. */
export const implement: ImplementTask = {
  name: "implement",
  limits: LIMITS,
  outputs: () => ({ implement: IMPLEMENT_RESULT }),
  start,
};
