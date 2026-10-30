import type { Timeouts } from "./run.js";

/** The timeout-shaped options shared by `run()`, `interactive()`, `createSandbox()`, `createWorktree()` and their handles. */
export interface TimeoutOptions {
  readonly idleTimeoutSeconds?: number;
  readonly completionTimeoutSeconds?: number;
  readonly timeouts?: Timeouts;
}

const TIMEOUTS_KEYS = [
  "copyToWorktreeMs",
  "gitSetupMs",
  "commitCollectionMs",
  "mergeToHostMs",
] as const satisfies ReadonlyArray<keyof Timeouts>;

const assertPositive = (
  name: string,
  unit: "seconds" | "milliseconds",
  value: unknown,
): void => {
  if (value === undefined) return;
  // `!(value > 0)` also rejects NaN. Infinity stays allowed (no timeout).
  if (typeof value !== "number" || !(value > 0)) {
    throw new Error(
      `${name} must be a positive number of ${unit}. Received: ${String(value)}`,
    );
  }
};

/**
 * Throw a clear error when a timeout option is zero, negative or NaN.
 *
 * Called at entry, before any worktree or sandbox exists: a non-positive
 * timeout would otherwise fire before the agent's first output (or fail a
 * lifecycle step instantly) with a misleading error.
 */
export const validateTimeoutOptions = (options: TimeoutOptions): void => {
  assertPositive("idleTimeoutSeconds", "seconds", options.idleTimeoutSeconds);
  assertPositive(
    "completionTimeoutSeconds",
    "seconds",
    options.completionTimeoutSeconds,
  );
  for (const key of TIMEOUTS_KEYS) {
    assertPositive(`timeouts.${key}`, "milliseconds", options.timeouts?.[key]);
  }
};
