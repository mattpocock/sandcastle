import type { Sandbox } from "./Sandbox.js";

// A handle's default detach deadline, which a bundled task's `start` moves
// earlier to the task's own. Keyed by the handle object: a task gets the
// handle `createSandbox` returned, and `detach()` on that handle reads it.

interface DeadlineSlot {
  /** The latest a deadline can be: the kill time minus the report margin. */
  readonly latestMs: number;
  /** A bundled task's default, never later than `latestMs`. */
  taskMs: number | undefined;
}

const slots = new WeakMap<object, DeadlineSlot>();

/** The margin a handle that isn't from `createSandbox` is assumed to need. */
const UNKNOWN_MARGIN_MS = 5 * 60_000;

/** Records a new handle's latest possible deadline. */
export const registerHandleDeadline = (
  handle: object,
  latestMs: number,
): void => {
  slots.set(handle, { latestMs, taskMs: undefined });
};

/** The latest a detach deadline on this handle can be. */
export const latestDeadlineMs = (sandbox: Sandbox): number =>
  slots.get(sandbox)?.latestMs ??
  sandbox.killTime.getTime() - UNKNOWN_MARGIN_MS;

/** Sets the handle's default detach deadline, clamped to the latest. */
export const setTaskDeadline = (sandbox: Sandbox, deadlineMs: number): void => {
  const slot = slots.get(sandbox);
  if (slot !== undefined) {
    slot.taskMs = Math.min(deadlineMs, slot.latestMs);
  }
};

/** The default detach deadline a bundled task set on this handle, if any. */
export const taskDeadlineOf = (handle: object): number | undefined =>
  slots.get(handle)?.taskMs;
