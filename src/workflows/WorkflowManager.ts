import { resolve } from "node:path";
import { WorkflowValidationError } from "./errors.js";
import type {
  WorkflowAgentOptions,
  WorkflowAgentResult,
  WorkflowRunOptions,
  WorkflowRunState,
} from "./types.js";
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
  const resolvingAgentRunner = {
    run: async <Output = unknown>(
      prompt: string,
      agentOptions?: WorkflowAgentOptions,
    ): Promise<WorkflowAgentResult<Output>> => {
      return agentRunner.run<Output>(
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

  try {
    const result = await definition.run(ctx);
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

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_AGENTS = 50;
const DEFAULT_BRANCH_PREFIX = "sandcastle/workflow";
