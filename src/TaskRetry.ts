import { Cause, Runtime } from "effect";
import { classifyProviderFailure } from "./AgentFallback.js";

/** Why an issue pipeline failed. Only `provider` and `infrastructure` are retried. */
export type PipelineFailureKind = "provider" | "infrastructure" | "task";

const infrastructureTags = new Set([
  "ExecHostError",
  "CopyError",
  "DockerError",
  "PodmanError",
  "SyncError",
  "WorktreeError",
  "WorktreeTimeoutError",
  "ContainerStartTimeoutError",
  "CopyToWorktreeTimeoutError",
  "CopyToWorktreeError",
  "SyncInTimeoutError",
  "HookTimeoutError",
  "GitSetupTimeoutError",
  "CommitCollectionTimeoutError",
  "MergeToHostTimeoutError",
]);

const unwrap = (error: unknown): unknown => {
  if (Runtime.isFiberFailure(error))
    return Cause.squash(error[Runtime.FiberFailureCauseId]);
  return error;
};

/** Short, credential-free description used in logs and evidence. */
export const describeFailure = (error: unknown): string => {
  const value = unwrap(error);
  if (value instanceof Error) {
    const tag = (value as { _tag?: unknown })._tag;
    return `${typeof tag === "string" ? tag : value.name}: ${value.message}`.slice(
      0,
      2000,
    );
  }
  return String(value).slice(0, 2000);
};

/**
 * Classify an issue pipeline failure. A provider failure is an agent failure
 * whose message matches a classified provider failure (including an exhausted
 * fallback chain). Sandbox, worktree, copy and lifecycle timeouts are
 * infrastructure. Everything else, including blocked or unapproved work, is a
 * task failure and is never retried automatically.
 */
export const classifyPipelineFailure = (
  error: unknown,
): PipelineFailureKind => {
  const value = unwrap(error);
  const tag =
    value && typeof value === "object"
      ? (value as { _tag?: unknown })._tag
      : undefined;
  if (typeof tag === "string" && infrastructureTags.has(tag))
    return "infrastructure";
  if (tag === "AgentError" && value instanceof Error)
    return classifyProviderFailure(value.message) ? "provider" : "task";
  return "task";
};

/** Stops launching new pipelines after consecutive provider failures. */
export interface CircuitBreaker {
  /** True once the threshold of consecutive provider failures is reached. */
  readonly open: boolean;
  /** Consecutive provider failures observed so far. */
  readonly consecutiveProviderFailures: number;
  record(outcome: PipelineFailureKind | "success"): void;
}

export const createCircuitBreaker = (threshold: number): CircuitBreaker => {
  if (!Number.isInteger(threshold) || threshold < 1)
    throw new RangeError(
      "Circuit breaker threshold must be a positive integer",
    );
  let consecutive = 0;
  return {
    get open() {
      return consecutive >= threshold;
    },
    get consecutiveProviderFailures() {
      return consecutive;
    },
    record(outcome) {
      // Task failures say nothing about provider health; leave the count.
      if (outcome === "provider") consecutive++;
      else if (outcome !== "task") consecutive = 0;
    },
  };
};

/** Thrown instead of starting a pipeline while the breaker is open. */
export class ProviderUnavailableError extends Error {
  constructor(readonly consecutiveProviderFailures: number) {
    super(
      `Provider unavailable: ${consecutiveProviderFailures} consecutive provider failures. ` +
        "New pipelines were not started; check provider status, authentication and fallbacks, then resume.",
    );
    this.name = "ProviderUnavailableError";
  }
}

/** One recorded attempt of an issue pipeline. */
export interface TaskAttempt {
  readonly attempt: number;
  readonly outcome: "succeeded" | PipelineFailureKind;
  readonly error?: string;
}

/** Error carrying every attempt when an issue pipeline finally fails. */
export class TaskAttemptsError extends Error {
  constructor(
    readonly attempts: readonly TaskAttempt[],
    readonly kind: PipelineFailureKind,
    readonly cause: unknown,
  ) {
    super(
      `${attempts.at(-1)?.error ?? "Pipeline failed"} (attempts: ${attempts
        .map((a) => `${a.attempt}:${a.outcome}`)
        .join(", ")})`,
    );
    this.name = "TaskAttemptsError";
  }
}

export interface TaskRetryOptions<T extends object> {
  /** Extra attempts after the first for provider/infrastructure failures. Default 1. */
  readonly retries?: number;
  /** Shared breaker across the run's pipelines. */
  readonly breaker?: CircuitBreaker;
  /** Run one attempt (one-based). Reuse the retained branch on later attempts. */
  run(attempt: number): Promise<T>;
  /** Observe each finished attempt, e.g. to log or record evidence. */
  onAttempt?(attempt: TaskAttempt): void;
}

/**
 * Run an issue pipeline with a retry budget for provider and infrastructure
 * failures. Task failures are rethrown at once. While the breaker is open no
 * attempt starts. The final failure is a `TaskAttemptsError` listing attempts.
 */
export const runTaskWithRetries = async <T extends object>(
  options: TaskRetryOptions<T>,
): Promise<T & { taskAttempts: readonly TaskAttempt[] }> => {
  const retries = options.retries ?? 1;
  if (!Number.isInteger(retries) || retries < 0)
    throw new RangeError("retries must be a non-negative integer");
  const attempts: TaskAttempt[] = [];
  for (let attempt = 1; ; attempt++) {
    if (options.breaker?.open)
      throw new ProviderUnavailableError(
        options.breaker.consecutiveProviderFailures,
      );
    try {
      const value = await options.run(attempt);
      const record: TaskAttempt = { attempt, outcome: "succeeded" };
      attempts.push(record);
      options.breaker?.record("success");
      options.onAttempt?.(record);
      return { ...value, taskAttempts: attempts };
    } catch (error) {
      const kind = classifyPipelineFailure(error);
      const record: TaskAttempt = {
        attempt,
        outcome: kind,
        error: describeFailure(error),
      };
      attempts.push(record);
      options.breaker?.record(kind);
      options.onAttempt?.(record);
      if (kind === "task" || attempt > retries || options.breaker?.open)
        throw new TaskAttemptsError(attempts, kind, error);
    }
  }
};
