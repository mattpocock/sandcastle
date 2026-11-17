import type { OutputDefinition } from "./Output.js";
import { claudeCode } from "./agents.js";
import type { OutputMap } from "./FinishReport.js";
import type { Sandbox } from "./Sandbox.js";
import type { OutputType, SessionProcess } from "./Session.js";
import type { SessionRecordOptions } from "./SessionRecord.js";
import type {
  TaskAgentOptions,
  TaskLimits,
  TaskSkillsContext,
} from "./Task.js";
import { startTask } from "./taskStart.js";

/** What `general.start` takes. */
export interface GeneralInput<
  O extends OutputDefinition | undefined = undefined,
> extends TaskAgentOptions {
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
  /**
   * The session's name, its record's and its key in the finish report.
   * Default `"general"`. Give each of several tasks on one handle its own: a
   * start rejects a name already running before it clones anything. A name
   * other than `"general"` is also the directory the repo is cloned into, so it
   * must be letters, digits, `_`, `.` and `-`, not starting with `.` or `-`.
   */
  readonly name?: string;
}

/** `general.outputs(output, name)`: the caller's `Output`, under the session's name. */
export type GeneralOutputs<
  O extends OutputDefinition,
  Name extends string = "general",
> = Readonly<Record<Name, O>>;

/** The `general` bundled task: any prompt, answered by Claude Code on Sonnet unless you pass `agent`. */
export interface GeneralTask {
  /** The task's name, and its session's unless you pass `name`. */
  readonly name: "general";
  /** 30 minutes for the session; a 40-minute sandbox time limit leaves room for setup and the report. */
  readonly limits: TaskLimits;
  /**
   * The `Output` definitions for `verifyFinishReport`: pass the same
   * `output` you gave `start`, or nothing, and the `name` you gave it,
   * if any. The final message is in the report either way.
   */
  readonly outputs: {
    (): OutputMap;
    <const O extends OutputDefinition>(output: O): GeneralOutputs<O>;
    <const O extends OutputDefinition, Name extends string>(
      output: O,
      name: Name,
    ): GeneralOutputs<O, Name>;
  };
  /**
   * Rejects a `name` already running on the handle before it clones
   * anything. Then clones `repo` (if given), runs `setup`, spawns the
   * session (named `name`, default `"general"`) and resolves once it runs. No skills are installed; the prompt
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
function outputs<const O extends OutputDefinition, Name extends string>(
  output: O,
  name: Name,
): GeneralOutputs<O, Name>;
function outputs(output?: OutputDefinition, name = "general"): OutputMap {
  return output === undefined ? {} : { [name]: output };
}

/** Any prompt, with an optional repo; returns the final message, plus your `Output` when given. */
export const general: GeneralTask = {
  name: "general",
  limits: LIMITS,
  outputs,
  start: async (sandbox, input) =>
    startTask(sandbox, {
      name: "general",
      session: input.name,
      limits: LIMITS,
      agent: input.agent ?? claudeCode("sonnet"),
      skills: [],
      prompt: input.prompt,
      output: input.output,
      repo: input.repo,
      branch: undefined,
      githubToken: input.githubToken,
      skillsContext: input.skillsContext,
      setup: input.setup ?? [],
      record: input.record,
      completionTimeoutSeconds: input.completionTimeoutSeconds,
    }),
};
