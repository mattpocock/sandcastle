import type {
  JsonSchema,
  WorkflowAgentInvoker,
  WorkflowAgentOptions,
  WorkflowAgentResult,
  WorkflowEvent,
} from "./types.js";

export interface WorkflowQualityLogger {
  event(event: Omit<WorkflowEvent, "timestamp">): void | Promise<void>;
}

export type RetryThunk<Value> = (
  attemptIndex: number,
) => Promise<Value> | Value;

export interface RetryOptions {
  readonly retries?: number;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly label?: string;
  readonly logger?: WorkflowQualityLogger;
}

export type LoopUntilDryFinder<Item> = (
  roundIndex: number,
  previousResults: readonly Item[],
) => Promise<readonly Item[]> | readonly Item[];

export interface LoopUntilDryOptions<Item> {
  readonly maxRounds?: number;
  readonly isDry?: (results: readonly Item[]) => boolean;
  readonly label?: string;
  readonly logger?: WorkflowQualityLogger;
}

export interface WorkflowQualityAgentOptions {
  readonly agent?: WorkflowAgentInvoker;
  readonly agentOptions?: WorkflowAgentOptions;
  readonly schema?: JsonSchema;
  readonly label?: string;
  readonly logger?: WorkflowQualityLogger;
}

export interface CheckpointOptions {
  readonly policy?: "require" | "auto";
  readonly throwOnRequired?: boolean;
  readonly label?: string;
  readonly logger?: WorkflowQualityLogger;
}

export interface CheckpointRequiredResult {
  readonly status: "checkpoint_required";
  readonly prompt: string;
  readonly label: string;
  readonly policy: "require";
}

export interface CheckpointApprovedResult {
  readonly status: "approved";
  readonly prompt: string;
  readonly label: string;
  readonly policy: "auto";
  readonly continued: true;
}

export type CheckpointResult =
  | CheckpointApprovedResult
  | CheckpointRequiredResult;

export class WorkflowCheckpointRequiredError extends Error {
  readonly code = "checkpoint_required";
  readonly checkpoint: CheckpointRequiredResult;

  constructor(checkpoint: CheckpointRequiredResult) {
    super(`Workflow checkpoint required: ${checkpoint.label}`);
    this.name = "WorkflowCheckpointRequiredError";
    this.checkpoint = checkpoint;
  }
}

export interface WorkflowQualityHelpers {
  retry<Value>(
    thunk: RetryThunk<Value>,
    options?: RetryOptions,
  ): Promise<Value>;
  loopUntilDry<Item>(
    findMore: LoopUntilDryFinder<Item>,
    options?: LoopUntilDryOptions<Item>,
  ): Promise<Item[]>;
  verify<Output = unknown>(
    finding: unknown,
    options?: WorkflowQualityAgentOptions,
  ): Promise<WorkflowAgentResult<Output>>;
  judgePanel<Output = unknown>(
    candidates: readonly unknown[],
    options?: WorkflowQualityAgentOptions,
  ): Promise<WorkflowAgentResult<Output>>;
  completenessCheck<Output = unknown>(
    report: unknown,
    options?: WorkflowQualityAgentOptions,
  ): Promise<WorkflowAgentResult<Output>>;
  checkpoint(
    prompt: string,
    options?: CheckpointOptions,
  ): Promise<CheckpointResult>;
}

export interface CreateWorkflowQualityHelpersOptions {
  readonly agent?: WorkflowAgentInvoker;
  readonly logger?: WorkflowQualityLogger;
}

export function createWorkflowQualityHelpers(
  defaults: CreateWorkflowQualityHelpersOptions = {},
): WorkflowQualityHelpers {
  return {
    retry: (thunk, options) =>
      retry(thunk, withDefaultLogger(options, defaults)),
    loopUntilDry: (findMore, options) =>
      loopUntilDry(findMore, withDefaultLogger(options, defaults)),
    verify: (finding, options) =>
      verify(finding, withDefaultAgentAndLogger(options, defaults)),
    judgePanel: (candidates, options) =>
      judgePanel(candidates, withDefaultAgentAndLogger(options, defaults)),
    completenessCheck: (report, options) =>
      completenessCheck(report, withDefaultAgentAndLogger(options, defaults)),
    checkpoint: (prompt, options) =>
      checkpoint(prompt, withDefaultLogger(options, defaults)),
  };
}

export async function retry<Value>(
  thunk: RetryThunk<Value>,
  options: RetryOptions = {},
): Promise<Value> {
  const maxAttempts = resolveMaxAttempts(options);
  const delayMs = resolveDelayMs(options.delayMs);
  const label = options.label ?? "retry";

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    const attempt = attemptIndex + 1;
    await emit(options.logger, {
      type: "quality_retry_attempt",
      message: label,
      details: { label, attempt, maxAttempts },
    });

    try {
      const value = await thunk(attemptIndex);
      await emit(options.logger, {
        type: "quality_retry_succeeded",
        message: label,
        details: { label, attempt, maxAttempts },
      });
      return value;
    } catch (error) {
      const exhausted = attempt === maxAttempts;
      await emit(options.logger, {
        type: exhausted ? "quality_retry_exhausted" : "quality_retry_failed",
        message: label,
        details: {
          label,
          attempt,
          maxAttempts,
          error: serializeError(error),
        },
      });

      if (exhausted) {
        throw error;
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw new Error("Workflow retry exhausted without an attempt.");
}

export async function loopUntilDry<Item>(
  findMore: LoopUntilDryFinder<Item>,
  options: LoopUntilDryOptions<Item> = {},
): Promise<Item[]> {
  const maxRounds = resolveMaxRounds(options.maxRounds);
  const label = options.label ?? "loop_until_dry";
  const isDry =
    options.isDry ?? ((results: readonly Item[]) => results.length === 0);
  const allResults: Item[] = [];
  let previousResults: readonly Item[] = [];

  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex++) {
    const round = roundIndex + 1;
    await emit(options.logger, {
      type: "quality_loop_round_started",
      message: label,
      details: { label, round, maxRounds },
    });

    const roundResults = await findMore(roundIndex, previousResults);

    await emit(options.logger, {
      type: "quality_loop_round_finished",
      message: label,
      details: {
        label,
        round,
        maxRounds,
        resultCount: roundResults.length,
      },
    });

    if (isDry(roundResults)) {
      await emit(options.logger, {
        type: "quality_loop_dry",
        message: label,
        details: { label, round, maxRounds },
      });
      return allResults;
    }

    allResults.push(...roundResults);
    previousResults = roundResults;
  }

  await emit(options.logger, {
    type: "quality_loop_max_rounds",
    message: label,
    details: { label, maxRounds, resultCount: allResults.length },
  });

  return allResults;
}

export async function verify<Output = unknown>(
  finding: unknown,
  options: WorkflowQualityAgentOptions = {},
): Promise<WorkflowAgentResult<Output>> {
  const label = resolveLabel(options, "Verify finding");
  const prompt = [
    "You are a verification agent for a Sandcastle dynamic workflow.",
    "",
    "Finding to verify:",
    formatPromptValue(finding),
    "",
    "Check whether the finding is accurate, supported, and actionable. Return a concise verdict with evidence and caveats.",
  ].join("\n");

  return runQualityAgent<Output>(
    "quality_verify_requested",
    prompt,
    label,
    options,
  );
}

export async function judgePanel<Output = unknown>(
  candidates: readonly unknown[],
  options: WorkflowQualityAgentOptions = {},
): Promise<WorkflowAgentResult<Output>> {
  const label = resolveLabel(options, "Judge panel");
  const summaries =
    candidates.length === 0
      ? "No candidates were supplied."
      : candidates.map(formatCandidateSummary).join("\n\n");
  const prompt = [
    "You are a judge agent for a Sandcastle dynamic workflow.",
    "",
    "Candidate summaries:",
    summaries,
    "",
    "Compare the candidates, identify the strongest option, and explain the tradeoffs that matter for the workflow goal.",
  ].join("\n");

  return runQualityAgent<Output>(
    "quality_judge_panel_requested",
    prompt,
    label,
    options,
  );
}

export async function completenessCheck<Output = unknown>(
  report: unknown,
  options: WorkflowQualityAgentOptions = {},
): Promise<WorkflowAgentResult<Output>> {
  const label = resolveLabel(options, "Completeness check");
  const prompt = [
    "You are a completeness reviewer for a Sandcastle dynamic workflow.",
    "",
    "Report to check:",
    formatPromptValue(report),
    "",
    "Find important gaps, omissions, unsupported claims, or follow-up work that the report misses. Return concise findings.",
  ].join("\n");

  return runQualityAgent<Output>(
    "quality_completeness_check_requested",
    prompt,
    label,
    options,
  );
}

export async function checkpoint(
  prompt: string,
  options: CheckpointOptions = {},
): Promise<CheckpointResult> {
  const label = options.label ?? "Checkpoint";
  const policy = options.policy ?? "require";

  if (policy === "auto") {
    const result: CheckpointApprovedResult = {
      status: "approved",
      prompt,
      label,
      policy,
      continued: true,
    };
    await emit(options.logger, {
      type: "quality_checkpoint_approved",
      message: label,
      details: result,
    });
    return result;
  }

  const result: CheckpointRequiredResult = {
    status: "checkpoint_required",
    prompt,
    label,
    policy: "require",
  };

  await emit(options.logger, {
    type: "quality_checkpoint_required",
    message: label,
    details: result,
  });

  if (options.throwOnRequired === true) {
    throw new WorkflowCheckpointRequiredError(result);
  }

  return result;
}

async function runQualityAgent<Output>(
  eventType: string,
  prompt: string,
  label: string,
  options: WorkflowQualityAgentOptions,
): Promise<WorkflowAgentResult<Output>> {
  await emit(options.logger, {
    type: eventType,
    message: label,
    details: { label },
  });

  const agent = resolveAgent(options.agent);
  return agent<Output>(prompt, {
    ...options.agentOptions,
    label,
    schema: options.schema ?? options.agentOptions?.schema,
  });
}

function resolveAgent(
  agent: WorkflowAgentInvoker | undefined,
): WorkflowAgentInvoker {
  if (agent === undefined) {
    throw new TypeError("Workflow quality helper requires an agent invoker.");
  }

  return agent;
}

function resolveLabel(
  options: Pick<WorkflowQualityAgentOptions, "agentOptions" | "label">,
  fallback: string,
): string {
  return options.label ?? options.agentOptions?.label ?? fallback;
}

function resolveMaxAttempts(options: RetryOptions): number {
  if (options.maxAttempts !== undefined) {
    assertIntegerAtLeast(options.maxAttempts, 1, "retry maxAttempts");
    return options.maxAttempts;
  }

  const retries = options.retries ?? 0;
  assertIntegerAtLeast(retries, 0, "retry retries");
  return retries + 1;
}

function resolveDelayMs(delayMs: number | undefined): number {
  if (delayMs === undefined) {
    return 0;
  }

  assertIntegerAtLeast(delayMs, 0, "retry delayMs");
  return delayMs;
}

function resolveMaxRounds(maxRounds: number | undefined): number {
  if (maxRounds === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  assertIntegerAtLeast(maxRounds, 0, "loopUntilDry maxRounds");
  return maxRounds;
}

function assertIntegerAtLeast(
  value: number,
  minimum: number,
  label: string,
): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer >= ${minimum}.`);
  }
}

function formatCandidateSummary(candidate: unknown, index: number): string {
  const heading = candidateLabel(candidate, index);
  const summary =
    isRecord(candidate) && typeof candidate.summary === "string"
      ? candidate.summary
      : formatPromptValue(candidate);

  return `${heading}:\n${summary}`;
}

function candidateLabel(candidate: unknown, index: number): string {
  const baseLabel = `Candidate ${index + 1}`;

  if (isRecord(candidate) && typeof candidate.label === "string") {
    return `${baseLabel} (${candidate.label})`;
  }

  return baseLabel;
}

function formatPromptValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    const formatted = JSON.stringify(value, null, 2);
    return formatted ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

async function emit(
  logger: WorkflowQualityLogger | undefined,
  event: Omit<WorkflowEvent, "timestamp">,
): Promise<void> {
  await Promise.resolve(logger?.event(event));
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function withDefaultLogger<
  Options extends { readonly logger?: WorkflowQualityLogger },
>(
  options: Options | undefined,
  defaults: CreateWorkflowQualityHelpersOptions,
): Options {
  return {
    ...options,
    logger: options?.logger ?? defaults.logger,
  } as Options;
}

function withDefaultAgentAndLogger(
  options: WorkflowQualityAgentOptions | undefined,
  defaults: CreateWorkflowQualityHelpersOptions,
): WorkflowQualityAgentOptions {
  return {
    ...options,
    agent: options?.agent ?? defaults.agent,
    logger: options?.logger ?? defaults.logger,
  };
}
