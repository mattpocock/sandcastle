import { Effect, Either } from "effect";
import type { OutputDefinition } from "./Output.js";
import type { Sandbox } from "./Sandbox.js";
import type { OutputType, SessionProcess } from "./Session.js";
import { installSkills } from "./skills/installSkills.js";
import type { TaskRun, TaskSkillsContext } from "./Task.js";
import type { TaskClaim } from "./taskClaim.js";
import { claimTask } from "./taskClaim.js";
import { checkAgentOptions } from "./sessionRequest.js";
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

const install = async (
  sandbox: Sandbox,
  skills: TaskRun<undefined>["skills"],
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

/** The task's own prompt, prepared in the clone when it's a function. */
const taskBody = async (
  prompt: TaskRun<OutputDefinition | undefined>["prompt"],
  directory: string | undefined,
): Promise<string> => {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (directory === undefined) {
    throw new TypeError("A task that prepares its clone needs a repo");
  }
  return prompt(directory);
};

/** The rest of `startTask`, once the session's name is taken. */
const spawnTask = async <O extends OutputDefinition | undefined>(
  sandbox: Sandbox,
  run: TaskRun<O>,
  claim: TaskClaim,
): Promise<SessionProcess<OutputType<O>>> => {
  const directory = await prepareRepo(sandbox, run);
  const body = await taskBody(run.prompt, directory);
  await install(sandbox, run.skills, run.skillsContext);
  await runSetup(sandbox, run.setup, directory);
  claim.setDeadline();
  return sandbox.spawnSession({
    name: claim.session,
    agent: run.agent,
    prompt: taskPrompt({
      body,
      tracker: run.skillsContext.tracker,
      output: run.output,
    }),
    ...(run.output === undefined ? {} : { output: run.output }),
    ...(directory === undefined ? {} : { workingDirectory: directory }),
    ...(run.githubToken === undefined
      ? {}
      : { env: { GH_TOKEN: run.githubToken } }),
    ...(run.record === undefined ? {} : { record: run.record }),
    ...(run.completionTimeoutSeconds === undefined
      ? {}
      : { completionTimeoutSeconds: run.completionTimeoutSeconds }),
  });
};

/**
 * Starts a bundled task: takes its session name on the handle (rejecting one
 * already running), clones its repo with the token in that command's env
 * only, checks out its branch, prepares the clone and the prompt, installs
 * its skills, runs the setup commands in the clone, then spawns one session
 * of that name and resolves once it runs. The handle's default detach
 * deadline becomes the task's.
 */
export const startTask = async <O extends OutputDefinition | undefined>(
  sandbox: Sandbox,
  run: TaskRun<O>,
): Promise<SessionProcess<OutputType<O>>> => {
  checkTracker(run.name, run.skillsContext);
  checkAgentOptions(run);
  const claim = claimTask(sandbox, run);
  try {
    return await spawnTask(sandbox, run, claim);
  } finally {
    claim.release();
  }
};
