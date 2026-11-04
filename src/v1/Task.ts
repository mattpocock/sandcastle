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
}
