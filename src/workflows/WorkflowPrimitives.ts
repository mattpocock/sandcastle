import type {
  JsonSchema,
  WorkflowAgentCall,
  WorkflowAgentInvoker,
  WorkflowAgentOptions,
  WorkflowAgentResult,
  WorkflowBudget,
  WorkflowContext,
  WorkflowEvent,
  WorkflowLogger,
  WorkflowParallelOptions,
  WorkflowParallelRunner,
  WorkflowPhaseReporter,
  WorkflowPipelineRunner,
  WorkflowRunState,
  WorkflowRuntime,
  WorkflowTask,
  WorkflowValidationResult,
  WorkflowValidator,
} from "./types.js";
import { validateJsonSchemaValue } from "./JsonSchemaStandardSchema.js";
import type { WorkflowAgentRunner } from "./WorkflowAgentRunner.js";
import { WorkflowRunStore } from "./WorkflowRunStore.js";
import { WorkflowScheduler } from "./WorkflowScheduler.js";

export interface WorkflowPrimitivesOptions<Args = unknown> {
  readonly args: Args;
  readonly runId: string;
  readonly cwd: string;
  readonly sourceFile?: string;
  readonly scheduler: WorkflowScheduler;
  readonly agentRunner: Pick<WorkflowAgentRunner, "run">;
  readonly store?: WorkflowRunStore;
  readonly initialState?: WorkflowRunState;
}

export function createWorkflowPrimitives<Args>(
  options: WorkflowPrimitivesOptions<Args>,
): WorkflowContext<Args> {
  let currentPhase = options.initialState?.currentPhase;
  let state = options.initialState ?? createInitialState(options);

  const currentState = (): WorkflowRunState => ({
    ...state,
    agentCount: options.scheduler.agentCount,
    maxAgents: options.scheduler.maxAgents,
    concurrency: options.scheduler.concurrency,
  });

  const persistState = async (): Promise<void> => {
    state = currentState();

    if (options.store === undefined) {
      return;
    }

    await options.store.writeState(options.runId, state);
  };

  const emit = async (
    event: Omit<WorkflowEvent, "timestamp">,
  ): Promise<void> => {
    if (options.store === undefined) {
      return;
    }

    try {
      await options.store.appendEvent(options.runId, {
        ...event,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Event persistence should not change workflow execution behavior.
    }
  };

  const phase = (async (title: string): Promise<void> => {
    currentPhase = title;
    state = { ...currentState(), currentPhase: title };
    await emit({
      type: "phase_started",
      message: title,
      details: { title },
    });
    await persistState();
  }) as WorkflowPhaseReporter;
  phase.current = () => currentPhase;

  const logEvent = (event: Omit<WorkflowEvent, "timestamp">): Promise<void> =>
    emit(event);

  const log: WorkflowLogger = {
    debug: (message: string, details?: unknown) =>
      logEvent({ type: "log_debug", message, details }),
    info: (message: string, details?: unknown) =>
      logEvent({ type: "log_info", message, details }),
    warn: (message: string, details?: unknown) =>
      logEvent({ type: "log_warn", message, details }),
    error: (message: string, details?: unknown) =>
      logEvent({ type: "log_error", message, details }),
    event: (event: Omit<WorkflowEvent, "timestamp">) => logEvent(event),
  };

  const runAgent = async <Output = unknown>(
    prompt: string,
    agentOptions?: WorkflowAgentOptions,
  ): Promise<WorkflowAgentResult<Output>> => {
    const label = agentOptions?.label;

    return options.scheduler.scheduleAgent(async () => {
      await emit({
        type: "agent_started",
        message: label,
        details: { label },
      });

      try {
        const result = await options.agentRunner.run<Output>(
          prompt,
          agentOptions,
        );

        await emit({
          type:
            result.status === "failed" ? "agent_failed" : "agent_succeeded",
          message: label,
          details: {
            label,
            status: result.status,
            branch: result.branch,
            error: result.error,
          },
        });

        return result;
      } catch (error) {
        await emit({
          type: "agent_failed",
          message: label,
          details: {
            label,
            error: serializeError(error),
          },
        });
        throw error;
      }
    });
  };

  const agent = runAgent as WorkflowAgentInvoker;
  agent.run = runAgent;

  const parallel = (async <T>(
    tasks: readonly WorkflowTask<T>[],
    parallelOptions?: WorkflowParallelOptions,
  ): Promise<T[]> => {
    return runWithLocalConcurrency(
      tasks,
      getLocalConcurrency(tasks.length, parallelOptions),
      (task) => options.scheduler.schedule(task),
    );
  }) as WorkflowParallelRunner;
  parallel.agents = async <Output = unknown>(
    calls: readonly WorkflowAgentCall[],
    parallelOptions?: WorkflowParallelOptions,
  ): Promise<WorkflowAgentResult<Output>[]> =>
    runWithLocalConcurrency(
      calls.map((call) => () => agent<Output>(call.prompt, call.options)),
      getLocalConcurrency(calls.length, parallelOptions),
      (task) => Promise.resolve().then(task),
    );

  const pipeline: WorkflowPipelineRunner = async <T>(
    steps: readonly WorkflowTask<T>[],
  ): Promise<T[]> => {
    const results: T[] = [];

    for (const step of steps) {
      results.push(await step());
    }

    return results;
  };

  const validate: WorkflowValidator = <Value = unknown>(
    value: unknown,
    schema: JsonSchema,
  ): WorkflowValidationResult<Value> => {
    const result = validateJsonSchemaValue<Value>(schema, value);

    if (result.ok) {
      return { ok: true, value: result.value };
    }

    return {
      ok: false,
      errors: result.issues.map((issue) => ({
        code: "json_schema",
        message: issue.message,
        path: issue.path,
        severity: "error",
      })),
    };
  };

  const workflow: WorkflowRuntime = {
    id: options.runId,
    cwd: options.cwd,
    sourceFile: options.sourceFile,
    state: () => {
      state = currentState();
      return state;
    },
    stop: async (reason?: string): Promise<void> => {
      options.scheduler.stop(reason);
      state = {
        ...currentState(),
        status: "stopped",
        finishedAt: new Date().toISOString(),
      };
      await emit({
        type: "workflow_stopped",
        message: reason,
        details: { reason },
      });
      await persistState();
    },
  };

  const budget: WorkflowBudget = {
    get maxAgents(): number {
      return options.scheduler.maxAgents;
    },
    get agentCount(): number {
      return options.scheduler.agentCount;
    },
    get concurrency(): number {
      return options.scheduler.concurrency;
    },
    remainingAgents: () =>
      Math.max(0, options.scheduler.maxAgents - options.scheduler.agentCount),
  };

  return {
    args: options.args,
    agent,
    parallel,
    pipeline,
    phase,
    log,
    validate,
    workflow,
    budget,
  };
}

function createInitialState(
  options: Pick<
    WorkflowPrimitivesOptions,
    "runId" | "cwd" | "sourceFile" | "scheduler"
  >,
): WorkflowRunState {
  return {
    id: options.runId,
    status: "running",
    cwd: options.cwd,
    sourceFile: options.sourceFile,
    agentCount: options.scheduler.agentCount,
    maxAgents: options.scheduler.maxAgents,
    concurrency: options.scheduler.concurrency,
  };
}

async function runWithLocalConcurrency<T>(
  tasks: readonly WorkflowTask<T>[],
  concurrency: number,
  schedule: (task: WorkflowTask<T>) => Promise<T>,
): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }

  return new Promise<T[]>((resolve, reject) => {
    const results = new Array<T>(tasks.length);
    let nextIndex = 0;
    let activeCount = 0;
    let completedCount = 0;
    let rejected = false;

    const launch = (): void => {
      if (rejected) {
        return;
      }

      if (completedCount === tasks.length) {
        resolve(results);
        return;
      }

      while (activeCount < concurrency && nextIndex < tasks.length) {
        const index = nextIndex++;
        const task = tasks[index];

        if (task === undefined) {
          continue;
        }

        activeCount++;
        schedule(task).then(
          (value) => {
            activeCount--;
            results[index] = value;
            completedCount++;
            launch();
          },
          (error) => {
            rejected = true;
            reject(error);
          },
        );
      }
    };

    launch();
  });
}

function getLocalConcurrency(
  taskCount: number,
  options?: WorkflowParallelOptions,
): number {
  if (taskCount === 0) {
    return 1;
  }

  if (options?.concurrency === undefined) {
    return taskCount;
  }

  if (
    !Number.isFinite(options.concurrency) ||
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1
  ) {
    throw new TypeError("Workflow parallel concurrency must be a positive finite integer.");
  }

  return Math.min(options.concurrency, taskCount);
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
