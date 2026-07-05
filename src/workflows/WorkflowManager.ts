import { resolve } from "node:path";
import { WorkflowValidationError } from "./errors.js";
import type { WorkflowRunOptions, WorkflowRunState } from "./types.js";
import { validateWorkflowSource } from "./validateWorkflowSource.js";
import { WorkflowAgentRunner } from "./WorkflowAgentRunner.js";
import { createWorkflowPrimitives } from "./WorkflowPrimitives.js";
import { WorkflowRunStore } from "./WorkflowRunStore.js";
import { WorkflowScheduler } from "./WorkflowScheduler.js";

export interface WorkflowRunResult {
  readonly runId: string;
  readonly status: "succeeded" | "failed";
  readonly result?: unknown;
  readonly error?: unknown;
  readonly runDir: string;
  readonly state: WorkflowRunState;
}

export class WorkflowManager {
  async run(options: WorkflowRunOptions): Promise<WorkflowRunResult> {
    return runWorkflowInternal(options);
  }
}

export async function runWorkflow(
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult> {
  return new WorkflowManager().run(options);
}

async function runWorkflowInternal(
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const loaded = await loadValidatedWorkflow(options, cwd);
  const definition = loaded.definition;
  const defaults = definition.defaults ?? {};
  const concurrency =
    options.concurrency ?? defaults.maxConcurrency ?? DEFAULT_CONCURRENCY;
  const maxAgents =
    options.maxAgents ?? defaults.maxAgents ?? DEFAULT_MAX_AGENTS;
  const branchPrefix =
    options.branchPrefix ?? defaults.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const store = new WorkflowRunStore({
    cwd,
    runsRoot: options.runsRoot,
  });
  const runId = options.runId ?? store.generateRunId(definition.meta.name);
  const initialState = await store.createRun({
    meta: definition.meta,
    cwd,
    source: loaded.source,
    sourceFile: loaded.sourceFile,
    runId,
    status: "running",
    agentCount: 0,
    maxAgents,
    concurrency,
  });
  const runDir = store.getRunDir(runId);
  const scheduler = new WorkflowScheduler({
    concurrency,
    maxAgents,
    signal: options.signal,
  });
  let getPhase: (() => string | undefined) | undefined;
  const agentRunner = new WorkflowAgentRunner({
    cwd,
    runId,
    branchPrefix,
    defaultAgent: options.defaultAgent,
    defaultSandbox: options.defaultSandbox,
    skills: options.skills,
    store,
    run: options.agentRun,
    getPhase: () => getPhase?.(),
    signal: options.signal,
  });
  const ctx = createWorkflowPrimitives({
    args: options.args,
    runId,
    cwd,
    sourceFile: loaded.sourceFile,
    scheduler,
    agentRunner,
    store,
    initialState,
  });
  getPhase = ctx.phase.current;

  try {
    const result = await definition.run(ctx);
    await store.writeResult(runId, result);
    await store.appendEvent(runId, {
      timestamp: new Date().toISOString(),
      type: "workflow_succeeded",
      details: { result },
    });
    const state: WorkflowRunState = {
      ...ctx.workflow.state(),
      status: "succeeded",
      result,
      finishedAt: new Date().toISOString(),
    };
    await store.writeState(runId, state);

    return {
      runId,
      status: "succeeded",
      result,
      runDir,
      state,
    };
  } catch (error) {
    const serializedError = serializeError(error);
    await store.writeError(runId, serializedError);
    await store.appendEvent(runId, {
      timestamp: new Date().toISOString(),
      type: "workflow_failed",
      details: { error: serializedError },
    });
    const state: WorkflowRunState = {
      ...ctx.workflow.state(),
      status: "failed",
      error: serializedError,
      finishedAt: new Date().toISOString(),
    };
    await store.writeState(runId, state);

    return {
      runId,
      status: "failed",
      error: serializedError,
      runDir,
      state,
    };
  }
}

async function loadValidatedWorkflow(options: WorkflowRunOptions, cwd: string) {
  const result = await validateWorkflowSource({
    cwd,
    source: options.source,
    sourceFile: options.sourceFile,
  });

  if (result.ok && result.value !== undefined) {
    return result.value;
  }

  throw new WorkflowValidationError("Workflow source validation failed.", {
    details: {
      errors: result.errors ?? [],
      warnings: result.warnings ?? [],
    },
  });
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error || isErrorLike(error)) {
    return {
      name: typeof error.name === "string" ? error.name : "Error",
      message: error.message,
      stack: typeof error.stack === "string" ? error.stack : undefined,
    };
  }

  return error;
}

function isErrorLike(
  value: unknown,
): value is {
  readonly name?: unknown;
  readonly message: string;
  readonly stack?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_AGENTS = 50;
const DEFAULT_BRANCH_PREFIX = "sandcastle/workflow";
