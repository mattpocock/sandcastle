import type { OutputDefinition } from "../Output.js";
import { claudeCode } from "./agents.js";
import type { OutputMap } from "./FinishReport.js";
import type { Sandbox } from "./Sandbox.js";
import type { OutputType, SessionProcess } from "./Session.js";
import type { SessionRecordOptions } from "./SessionRecord.js";
import type { TaskLimits, TaskSkillsContext } from "./Task.js";
import { startTask } from "./taskStart.js";

/** What `general.start` takes. */
export interface GeneralInput<
  O extends OutputDefinition | undefined = undefined,
> {
  /** The question or job, in your words. */
  readonly prompt: string;
  /**
   * The repo to clone into the working directory: `owner/name` on GitHub,
   * or any URL or path `git clone` takes. Leave it out to work without one.
   */
  readonly repo?: string;
  /**
   * A GitHub token, read-only is enough. It reaches only the clone command
   * and the session, as `GH_TOKEN`. Needed for a private repo.
   */
  readonly githubToken?: string;
  /** The tracker whose instructions go into the prompt. */
  readonly skillsContext: TaskSkillsContext;
  /** Typed JSON or text to hand back besides the final message. Its tag is added to the prompt. */
  readonly output?: O;
  /** Commands run in the clone, in order, before the session; the first failure rejects. */
  readonly setup?: readonly string[];
  /** Where the session's record goes when it ends. */
  readonly record?: SessionRecordOptions;
}

/** `general.outputs(output)`: the caller's `Output`, under the session's name. */
export type GeneralOutputs<O extends OutputDefinition> = Readonly<
  Record<"general", O>
>;

/** The `general` bundled task: any prompt, answered by Claude Code on Sonnet. */
export interface GeneralTask {
  /** The task's name, and the name of its session in the finish report. */
  readonly name: "general";
  /** 30 minutes for the session; a 40-minute sandbox time limit leaves room for setup and the report. */
  readonly limits: TaskLimits;
  /**
   * The `Output` definitions for `verifyFinishReport`: pass the same
   * `output` you gave `start`, or nothing. The final message is in the
   * report either way.
   */
  readonly outputs: {
    (): OutputMap;
    <const O extends OutputDefinition>(output: O): GeneralOutputs<O>;
  };
  /**
   * Clones `repo` (if given), runs `setup`, then spawns the `general`
   * session and resolves once it runs. No skills are installed; the prompt
   * carries the tracker instructions, the output tag and the rule that no
   * human is watching. Rejects when the sandbox's kill time leaves less room
   * than `limits.deadlineMinutes`.
   */
  readonly start: <const O extends OutputDefinition | undefined = undefined>(
    sandbox: Sandbox,
    input: GeneralInput<O>,
  ) => Promise<SessionProcess<OutputType<O>>>;
}

const LIMITS: TaskLimits = { timeLimitMinutes: 40, deadlineMinutes: 30 };

function outputs(): OutputMap;
function outputs<const O extends OutputDefinition>(
  output: O,
): GeneralOutputs<O>;
function outputs(output?: OutputDefinition): OutputMap {
  return output === undefined ? {} : { general: output };
}

/** Any prompt, with an optional repo; returns the final message, plus your `Output` when given. */
export const general: GeneralTask = {
  name: "general",
  limits: LIMITS,
  outputs,
  start: async (sandbox, input) =>
    startTask(sandbox, {
      name: "general",
      limits: LIMITS,
      agent: claudeCode("sonnet"),
      skills: [],
      prompt: input.prompt,
      output: input.output,
      repo: input.repo,
      githubToken: input.githubToken,
      skillsContext: input.skillsContext,
      setup: input.setup ?? [],
      record: input.record,
    }),
};
