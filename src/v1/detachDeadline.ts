import { DateTime } from "effect";
import type { Sandbox } from "./Sandbox.js";

// A handle's detach deadline (ADR 0028): the latest one, before the kill time,
// and the default, which a bundled task's `start` may move earlier to the
// task's own. Keyed by the handle object: a task gets the handle
// `createSandbox` returned, and `detach()` on that handle reads it.

const MARGIN_MINUTES = 5;

interface DeadlineSlot {
  /** The latest a deadline can be: the kill time minus the report margin. */
  readonly latestMs: number;
  /** A bundled task's default, never later than `latestMs`. */
  taskMs: number | undefined;
}

const slots = new WeakMap<object, DeadlineSlot>();

/**
 * The latest deadline: the kill time minus a margin to deliver the report.
 * The margin is 5 minutes, or a quarter of the time limit when that's
 * shorter, so a seconds-long sandbox still gets a deadline before its end.
 */
const latestMsFor = (killTime: Date, timeLimitMinutes: number): number =>
  killTime.getTime() - Math.min(MARGIN_MINUTES, timeLimitMinutes / 4) * 60_000;

/** Records a new handle's latest possible deadline. */
export const trackDeadline = (
  handle: object,
  killTime: Date,
  timeLimitMinutes: number,
): void => {
  slots.set(handle, {
    latestMs: latestMsFor(killTime, timeLimitMinutes),
    taskMs: undefined,
  });
};

/** The latest a detach deadline on this handle can be. */
export const latestDeadlineMs = (sandbox: Sandbox): number =>
  slots.get(sandbox)?.latestMs ?? latestMsFor(sandbox.killTime, Infinity);

/** Sets the handle's default detach deadline, clamped to the latest. */
export const setTaskDeadline = (sandbox: Sandbox, deadlineMs: number): void => {
  const slot = slots.get(sandbox);
  if (slot !== undefined) {
    slot.taskMs = Math.min(deadlineMs, slot.latestMs);
  }
};

/** A detach's deadline, as the host's clock has it now. */
export interface DetachDeadline {
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly deadline: Date;
}

/**
 * The deadline for a detach from `handle`: `deadlineMinutes` from now when
 * given, else a bundled task's default, else the latest; never past the latest.
 */
export const detachDeadline = ({
  handle,
  killTime,
  timeLimitMinutes,
  deadlineMinutes,
}: {
  readonly handle: object;
  readonly killTime: Date;
  readonly timeLimitMinutes: number;
  readonly deadlineMinutes: number | undefined;
}): DetachDeadline => {
  const nowMs = DateTime.unsafeNow().epochMillis;
  const slot = slots.get(handle);
  const latest = slot?.latestMs ?? latestMsFor(killTime, timeLimitMinutes);
  const wanted =
    deadlineMinutes === undefined
      ? (slot?.taskMs ?? latest)
      : nowMs + deadlineMinutes * 60_000;
  const deadlineMs = Math.min(latest, wanted);
  return {
    nowMs,
    deadlineMs,
    deadline: DateTime.toDateUtc(DateTime.unsafeMake(deadlineMs)),
  };
};
