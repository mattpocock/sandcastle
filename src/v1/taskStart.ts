import { DateTime, Effect, Either } from "effect";
import type { OutputDefinition } from "../Output.js";
import type { Sandbox } from "./Sandbox.js";
import type { OutputType, SessionProcess } from "./Session.js";
import { installSkills } from "./skills/installSkills.js";
import type { Skill } from "./skills/Skill.js";
import type { TaskLimits, TaskRun, TaskSkillsContext } from "./Task.js";
import { latestDeadlineMs, setTaskDeadline } from "./detachDeadline.js";
import { prepareRepo } from "./taskBranch.js";
import { taskPrompt } from "./taskPrompt.js";

// The bundled task contract: what every task's `start` does, in order.

/** `tracker` is required by the types; this catches untyped callers. */
const checkTracker = (name: string, context: unknown): void => {
  if (
    typeof context !== "object" ||
    context === null ||
    !("tracker" in context) ||
    context.tracker === undefined
  ) {
    throw new TypeError(`${name}: skillsContext.tracker is required`);
  }
};

/** The task's deadline, from now; rejects when the kill time is too close. */
const taskDeadline = (sandbox: Sandbox, name: string, limits: TaskLimits) => {
  const now = DateTime.unsafeNow().epochMillis;
  const deadline = now + limits.deadlineMinutes * 60_000;
  const latest = latestDeadlineMs(sandbox);
  if (deadline > latest) {
    const room = Math.max(0, (latest - now) / 60_000).toFixed(1);
    throw new RangeError(
      `${name}: the sandbox leaves ${room} minutes before its detach deadline, but the task needs ${limits.deadlineMinutes}. Create it with timeLimitMinutes: ${name}.limits.timeLimitMinutes (${limits.timeLimitMinutes}).`,
    );
  }
  return deadline;
};

const install = async (
  sandbox: Sandbox,
  skills: readonly Skill[],
  context: TaskSkillsContext,
): Promise<void> => {
  if (skills.length === 0) {
    return;
  }
  const done = await Effect.runPromise(
    Effect.either(
      installSkills(sandbox, skills, {
        agent: "claudeCode",
        tracker: context.tracker,
      }),
    ),
  );
  if (Either.isLeft(done)) {
    throw new Error(done.left.message, { cause: done.left.cause });
  }
};

const runSetup = async (
  sandbox: Sandbox,
  setup: readonly string[],
  workingDirectory: string | undefined,
): Promise<void> =>
  setup
    .reduce<Promise<unknown>>(
      async (previous, command) =>
        previous.then(async () =>
          sandbox.exec({
            command,
            ...(workingDirectory === undefined ? {} : { workingDirectory }),
          }),
        ),
      Promise.resolve(),
    )
    .then(() => undefined);

/**
 * Starts a bundled task: clones its repo with the token in that command's env
 * only, checks out its branch, installs its skills, runs the setup commands in the clone, then
 * spawns one session named after the task and resolves once it runs. The
 * handle's default detach deadline becomes the task's.
 */
export const startTask = async <O extends OutputDefinition | undefined>(
  sandbox: Sandbox,
  run: TaskRun<O>,
): Promise<SessionProcess<OutputType<O>>> => {
  checkTracker(run.name, run.skillsContext);
  const deadline = taskDeadline(sandbox, run.name, run.limits);
  const directory = await prepareRepo(sandbox, run);
  await install(sandbox, run.skills, run.skillsContext);
  await runSetup(sandbox, run.setup, directory);
  setTaskDeadline(sandbox, deadline);
  return sandbox.spawnSession({
    name: run.name,
    agent: run.agent,
    prompt: taskPrompt({
      body: run.prompt,
      tracker: run.skillsContext.tracker,
      output: run.output,
    }),
    ...(run.output === undefined ? {} : { output: run.output }),
    ...(directory === undefined ? {} : { workingDirectory: directory }),
    ...(run.githubToken === undefined
      ? {}
      : { env: { GH_TOKEN: run.githubToken } }),
    ...(run.record === undefined ? {} : { record: run.record }),
  });
};
