import { DateTime } from "effect";
import type { OutputDefinition } from "./Output.js";
import type { Sandbox } from "./Sandbox.js";
import type { TaskLimits, TaskRun } from "./Task.js";
import { latestDeadlineMs, setTaskDeadline } from "./detachDeadline.js";
import { claimSessionName } from "./sessionNames.js";

// What a bundled task's `start` takes on the handle before it clones: its
// session's name, which no other session may be running under, and its
// deadline, which the sandbox's kill time must leave room for.

/** A session name is also a clone's directory: one plain directory name. */
const SESSION_NAME = /^[A-Za-z0-9_][\w.-]*$/u;

/** The session's name, checked; throws on one that can't name a directory. */
const sessionName = (run: TaskRun<OutputDefinition | undefined>): string => {
  const name = run.session ?? run.name;
  if (!SESSION_NAME.test(name)) {
    throw new TypeError(
      `${run.name}: name "${name}" must be letters, digits, "_", "." and "-", not starting with "." or "-"`,
    );
  }
  return name;
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

/** A task start's hold on the handle, from before its clone until it spawns. */
export interface TaskClaim {
  /** The session's name. */
  readonly session: string;
  /** Makes the task's deadline the handle's default detach deadline. */
  readonly setDeadline: () => void;
  /** Lets go of the name: once the session has spawned, or the start failed. */
  readonly release: () => void;
}

/**
 * Checks the session's name and the task's deadline, then takes the name on
 * the handle; throws, before anything runs in the sandbox, on a name that
 * can't name a directory, a kill time too close, or a name already running.
 */
export const claimTask = (
  sandbox: Sandbox,
  run: TaskRun<OutputDefinition | undefined>,
): TaskClaim => {
  const session = sessionName(run);
  const deadline = taskDeadline(sandbox, run.name, run.limits);
  const release = claimSessionName(sandbox, run.name, session);
  return {
    session,
    setDeadline: () => {
      setTaskDeadline(sandbox, deadline);
    },
    release,
  };
};
