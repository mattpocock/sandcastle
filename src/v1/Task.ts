import type { OutputDefinition } from "./Output.js";
import type { AgentProvider } from "./agents.js";
import type { SessionRecordOptions } from "./SessionRecord.js";
import type { Skill, Tracker } from "./skills/Skill.js";
import type { TaskBranch } from "./taskBranch.js";

export type { Tracker } from "./skills/Skill.js";

/**
 * A bundled task's own time-limit assumptions. Pass `timeLimitMinutes` to
 * `createSandbox`; `start` sets the handle's default detach deadline to
 * `deadlineMinutes` from when it was called.
 */
export interface TaskLimits {
  /** A sandbox time limit with room for the task: its deadline, setup and the report margin. */
  readonly timeLimitMinutes: number;
  /**
   * How long the task's session may run, counted from `start`. It becomes
   * the default deadline of a later `detach()`; an explicit `deadlineMinutes`
   * there still wins. `start` rejects when the sandbox's kill time leaves
   * less room than this.
   */
  readonly deadlineMinutes: number;
}

/** What a bundled task's skills and prompt are rendered from. */
export interface TaskSkillsContext {
  /** Where the run's tickets and specs live. Its instructions win over the repo's own CLAUDE.md or AGENTS.md. */
  readonly tracker: Tracker;
}

/**
 * The agent options every bundled task's `start` takes, beside its own input.
 */
export interface TaskAgentOptions {
  /**
   * The agent and model the task's session runs, from a built-in agent
   * factory (`claudeCode()`, `codex()`, `cursor()`, `opencode()`,
   * `copilot()`, `pi()`), or `fakeAgent()` from `/v1/testing` in tests.
   * Default: Claude Code on the task's own model (Sonnet for `general` and
   * `review`, Opus for `implement`). Give the agent env of its own, such as
   * its token, through the factory: `claudeCode("opus", { env })`. The task's
   * skills are installed where Claude Code reads them, and its prompt is the
   * same whichever agent runs it. `start` rejects an agent not made by a
   * built-in factory before it clones anything.
   */
  readonly agent?: AgentProvider;
  /**
   * Once the task's output closing tag has appeared, how long the agent may
   * stay silent before its process is stopped and the session counts as
   * done. Default 60, the session's own default. `start` rejects a value
   * that isn't a positive number before it clones anything.
   */
  readonly completionTimeoutSeconds?: number;
}

/** What a task hands the bundled task contract (`startTask`) to start it. Internal. */
export interface TaskRun<O extends OutputDefinition | undefined> {
  /** The task's name, and its session's. */
  readonly name: string;
  readonly limits: TaskLimits;
  readonly agent: AgentProvider;
  readonly skills: readonly Skill[];
  /**
   * The task's own prompt, before the parts every task adds. A function gets
   * the clone's directory once it's cloned and on its branch, may prepare it
   * (check out a pull request), and returns the prompt; it runs before the
   * skills and setup.
   */
  readonly prompt: string | ((clone: string) => Promise<string>);
  readonly output: O | undefined;
  readonly repo: string | undefined;
  /** The branch to work on in the clone; `undefined` keeps the one cloned. */
  readonly branch: TaskBranch | undefined;
  readonly githubToken: string | undefined;
  readonly skillsContext: TaskSkillsContext;
  readonly setup: readonly string[];
  readonly record: SessionRecordOptions | undefined;
  readonly completionTimeoutSeconds: number | undefined;
}
