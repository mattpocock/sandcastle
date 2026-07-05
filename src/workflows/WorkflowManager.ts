import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { WorkflowStoppedError, WorkflowValidationError } from "./errors.js";
import type {
  WorkflowAgentOptions,
  WorkflowAgentResult,
  WorkflowControlState,
  WorkflowRunOptions,
  WorkflowRunState,
  WorkflowRunStatus,
} from "./types.js";
import { validateWorkflowSource } from "./validateWorkflowSource.js";
import { WorkflowAgentRunner } from "./WorkflowAgentRunner.js";
import { createWorkflowPrimitives } from "./WorkflowPrimitives.js";
import { WorkflowRunStore } from "./WorkflowRunStore.js";
import { WorkflowScheduler } from "./WorkflowScheduler.js";

export interface WorkflowRunResult {
  readonly runId: string;
  readonly status: Extract<
    WorkflowRunStatus,
    "succeeded" | "failed" | "paused" | "stopped"
  >;
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
  const runtimeDefaults = {
    provider: options.provider ?? defaults.provider,
    model: options.model ?? defaults.model,
    sandbox: options.sandbox ?? defaults.sandbox,
    skills: options.defaultSkillNames ?? defaults.skills,
  };
  const store = new WorkflowRunStore({
    cwd,
    runsRoot: options.runsRoot,
  });
  const runId = options.runId ?? store.generateRunId(definition.meta.name);
  if (options.resume?.fromRunId === runId) {
    throw new WorkflowValidationError(
      "Workflow resume requires a different runId from resume.fromRunId.",
    );
  }
  const resumeJournal =
    options.resume === undefined
      ? undefined
      : await store.readJournal(options.resume.fromRunId);
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
  const controlAbortController = new AbortController();
  const workflowSignal = createLinkedAbortSignal(
    options.signal,
    controlAbortController.signal,
  );
  let scheduler: WorkflowScheduler;
  let controlError: WorkflowStoppedError | undefined;
  const observeControlState = async (): Promise<void> => {
    if (controlError !== undefined) {
      throw controlError;
    }

    const control = await store.readControl(runId);
    const requestedError = createControlError(control);
    if (requestedError === undefined) {
      return;
    }

    controlError = requestedError;
    if (getControlKind(requestedError) === "stop") {
      controlAbortController.abort(requestedError);
    }
    scheduler.stop(requestedError);
    throw requestedError;
  };

  scheduler = new WorkflowScheduler({
    concurrency,
    maxAgents,
    signal: workflowSignal.signal,
    beforeStart: observeControlState,
  });
  let getPhase: (() => string | undefined) | undefined;
  const agentRunner = new WorkflowAgentRunner({
    cwd,
    runId,
    branchPrefix,
    sourceHash: hashString(loaded.source),
    defaultAgent: options.defaultAgent,
    defaultSandbox: options.defaultSandbox,
    skills: options.skills,
    store,
    resumeFromRunId: options.resume?.fromRunId,
    resumeJournal,
    run: options.agentRun,
    getPhase: () => getPhase?.(),
    signal: workflowSignal.signal,
  });
  const resolvingAgentRunner = {
    run: async <Output = unknown>(
      prompt: string,
      agentOptions?: WorkflowAgentOptions,
    ): Promise<WorkflowAgentResult<Output>> => {
      await observeControlState();
      const result = await agentRunner.run<Output>(
        prompt,
        await resolveWorkflowAgentOptions({
          options: agentOptions,
          cwd,
          runId,
          runtimeDefaults,
          defaultAgent: options.defaultAgent,
          defaultSandbox: options.defaultSandbox,
          resolveAgentProvider: options.resolveAgentProvider,
          resolveSandbox: options.resolveSandbox,
        }),
      );
      await observeControlState();
      return result;
    },
  };
  const ctx = createWorkflowPrimitives({
    args: options.args,
    runId,
    cwd,
    sourceFile: loaded.sourceFile,
    scheduler,
    agentRunner: resolvingAgentRunner,
    store,
    initialState,
  });
  getPhase = ctx.phase.current;
  const controlPoll = setInterval(() => {
    void observeControlState().catch(() => {});
  }, CONTROL_POLL_INTERVAL_MS);
  controlPoll.unref?.();

  try {
    await observeControlState();
    const result = await definition.run(ctx);
    await observeControlState();
    if (result !== undefined) {
      await store.writeResult(runId, result);
    }
    await store.appendEvent(runId, {
      timestamp: new Date().toISOString(),
      type: "workflow_succeeded",
      details: result === undefined ? undefined : { result },
    });
    const state: WorkflowRunState = {
      ...ctx.workflow.state(),
      status: "succeeded",
      ...(result === undefined ? {} : { result }),
      finishedAt: new Date().toISOString(),
    };
    await store.writeState(runId, state);

    return {
      runId,
      status: "succeeded",
      ...(result === undefined ? {} : { result }),
      runDir,
      state,
    };
  } catch (error) {
    const controlKind = getControlKind(error);
    if (controlKind !== undefined) {
      const status = controlKind === "stop" ? "stopped" : "paused";
      const reason = getControlReason(error);
      const eventType =
        controlKind === "stop" ? "workflow_stopped" : "workflow_paused";
      await store.appendEvent(runId, {
        timestamp: new Date().toISOString(),
        type: eventType,
        message: reason,
        details: { reason },
      });
      const state: WorkflowRunState = {
        ...ctx.workflow.state(),
        status,
        finishedAt: new Date().toISOString(),
      };
      await store.writeState(runId, state);

      return {
        runId,
        status,
        runDir,
        state,
      };
    }

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
  } finally {
    clearInterval(controlPoll);
    workflowSignal.dispose();
  }
}

interface ResolveWorkflowAgentOptionsInput {
  readonly options?: WorkflowAgentOptions;
  readonly cwd: string;
  readonly runId: string;
  readonly runtimeDefaults: {
    readonly provider?: WorkflowRunOptions["provider"];
    readonly model?: string;
    readonly sandbox?: WorkflowRunOptions["sandbox"];
    readonly skills?: readonly string[];
  };
  readonly defaultAgent?: WorkflowRunOptions["defaultAgent"];
  readonly defaultSandbox?: WorkflowRunOptions["defaultSandbox"];
  readonly resolveAgentProvider?: WorkflowRunOptions["resolveAgentProvider"];
  readonly resolveSandbox?: WorkflowRunOptions["resolveSandbox"];
}

function resolveWorkflowAgentOptions(
  input: ResolveWorkflowAgentOptionsInput,
): WorkflowAgentOptions | Promise<WorkflowAgentOptions> {
  const options = input.options ?? {};
  const provider = options.provider ?? input.runtimeDefaults.provider;
  const model = options.model ?? input.runtimeDefaults.model;
  const sandboxName = options.sandboxName ?? input.runtimeDefaults.sandbox;
  const skills = options.skills ?? input.runtimeDefaults.skills;

  const agent =
    options.agent ??
    resolveWorkflowAgentProvider({
      provider,
      model,
      cwd: input.cwd,
      runId: input.runId,
      defaultAgent: input.defaultAgent,
      resolveAgentProvider: input.resolveAgentProvider,
      explicitProviderRequested:
        options.provider !== undefined || options.model !== undefined,
    });
  const sandbox =
    options.sandbox ??
    resolveWorkflowSandbox({
      sandbox: sandboxName,
      cwd: input.cwd,
      runId: input.runId,
      defaultSandbox: input.defaultSandbox,
      resolveSandbox: input.resolveSandbox,
      explicitSandboxRequested: options.sandboxName !== undefined,
    });

  return Promise.all([agent, sandbox]).then(
    ([resolvedAgent, resolvedSandbox]) => ({
      ...options,
      provider,
      model,
      sandboxName,
      skills,
      agent: resolvedAgent,
      sandbox: resolvedSandbox,
    }),
  );
}

interface ResolveWorkflowAgentProviderInput {
  readonly provider?: WorkflowRunOptions["provider"];
  readonly model?: string;
  readonly cwd: string;
  readonly runId: string;
  readonly defaultAgent?: WorkflowRunOptions["defaultAgent"];
  readonly resolveAgentProvider?: WorkflowRunOptions["resolveAgentProvider"];
  readonly explicitProviderRequested: boolean;
}

function resolveWorkflowAgentProvider(
  input: ResolveWorkflowAgentProviderInput,
) {
  if (
    input.resolveAgentProvider !== undefined &&
    input.provider !== undefined
  ) {
    return input.resolveAgentProvider({
      provider: input.provider,
      model: input.model,
      cwd: input.cwd,
      runId: input.runId,
    });
  }

  if (input.defaultAgent !== undefined && !input.explicitProviderRequested) {
    return input.defaultAgent;
  }

  throw new WorkflowValidationError(
    "Workflow agent call requires an agent provider. Pass options.agent, configure defaultAgent, or provide resolveAgentProvider for workflow provider/model names.",
  );
}

interface ResolveWorkflowSandboxInput {
  readonly sandbox?: WorkflowRunOptions["sandbox"];
  readonly cwd: string;
  readonly runId: string;
  readonly defaultSandbox?: WorkflowRunOptions["defaultSandbox"];
  readonly resolveSandbox?: WorkflowRunOptions["resolveSandbox"];
  readonly explicitSandboxRequested: boolean;
}

function resolveWorkflowSandbox(input: ResolveWorkflowSandboxInput) {
  if (input.resolveSandbox !== undefined && input.sandbox !== undefined) {
    return input.resolveSandbox({
      sandbox: input.sandbox,
      cwd: input.cwd,
      runId: input.runId,
    });
  }

  if (input.defaultSandbox !== undefined && !input.explicitSandboxRequested) {
    return input.defaultSandbox;
  }

  throw new WorkflowValidationError(
    "Workflow agent call requires a sandbox provider. Pass options.sandbox, configure defaultSandbox, or provide resolveSandbox for workflow sandbox names.",
  );
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

function isErrorLike(value: unknown): value is {
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

function createControlError(
  control: WorkflowControlState,
): WorkflowStoppedError | undefined {
  if (control.stopRequested) {
    return new WorkflowStoppedError("Workflow stop requested.", {
      details: {
        control: "stop",
        reason: control.stopReason,
      },
    });
  }

  if (control.pauseRequested) {
    return new WorkflowStoppedError("Workflow pause requested.", {
      details: {
        control: "pause",
        reason: control.pauseReason,
      },
    });
  }

  return undefined;
}

function getControlKind(error: unknown): "pause" | "stop" | undefined {
  if (!(error instanceof WorkflowStoppedError)) {
    return undefined;
  }

  const details = error.details;
  if (typeof details !== "object" || details === null) {
    return undefined;
  }

  const control = (details as { readonly control?: unknown }).control;
  return control === "stop" || control === "pause" ? control : undefined;
}

function getControlReason(error: unknown): string | undefined {
  if (!(error instanceof WorkflowStoppedError)) {
    return undefined;
  }

  const details = error.details;
  if (typeof details !== "object" || details === null) {
    return undefined;
  }

  const reason = (details as { readonly reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function createLinkedAbortSignal(
  externalSignal: AbortSignal | undefined,
  controlSignal: AbortSignal,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  if (externalSignal === undefined) {
    return { signal: controlSignal, dispose: () => {} };
  }

  const sourceSignal = externalSignal;
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
    cleanup();
  };
  const onExternalAbort = () => abortFrom(sourceSignal);
  const onControlAbort = () => abortFrom(controlSignal);
  function cleanup() {
    sourceSignal.removeEventListener("abort", onExternalAbort);
    controlSignal.removeEventListener("abort", onControlAbort);
  }

  if (sourceSignal.aborted) {
    abortFrom(sourceSignal);
  } else if (controlSignal.aborted) {
    abortFrom(controlSignal);
  } else {
    sourceSignal.addEventListener("abort", onExternalAbort, { once: true });
    controlSignal.addEventListener("abort", onControlAbort, { once: true });
  }

  return { signal: controller.signal, dispose: cleanup };
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_AGENTS = 50;
const DEFAULT_BRANCH_PREFIX = "sandcastle/workflow";
const CONTROL_POLL_INTERVAL_MS = 25;

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
