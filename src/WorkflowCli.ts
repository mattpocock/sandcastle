import { resolve } from "node:path";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
} from "./AgentProvider.js";
import { getAgent } from "./InitService.js";
import type { AgentProvider } from "./AgentProvider.js";
import type { SandboxProvider } from "./SandboxProvider.js";
import { daytona } from "./sandboxes/daytona.js";
import { docker } from "./sandboxes/docker.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import { podman } from "./sandboxes/podman.js";
import { vercel } from "./sandboxes/vercel.js";
import { runWorkflow } from "./workflows/WorkflowManager.js";
import { WorkflowRunStore } from "./workflows/WorkflowRunStore.js";
import { validateWorkflowSource } from "./workflows/validateWorkflowSource.js";
import type {
  WorkflowProviderName,
  WorkflowRunOptions,
  WorkflowSandboxName,
} from "./workflows/types.js";

const providerNames = [
  "claude-code",
  "pi",
  "codex",
  "cursor",
  "opencode",
  "copilot",
] as const satisfies readonly WorkflowProviderName[];

const sandboxNames = [
  "docker",
  "podman",
  "vercel",
  "daytona",
  "no-sandbox",
] as const satisfies readonly WorkflowSandboxName[];

export interface WorkflowCliValidateOptions {
  readonly file: string;
  readonly json: boolean;
  readonly cwd: string;
}

export interface WorkflowCliRunOptions {
  readonly file: string;
  readonly argsJson?: string;
  readonly json: boolean;
  readonly cwd: string;
  readonly provider?: WorkflowProviderName;
  readonly model?: string;
  readonly sandbox?: WorkflowSandboxName;
  readonly concurrency?: number;
  readonly maxAgents?: number;
  readonly branchPrefix?: string;
}

export interface WorkflowCliControlOptions {
  readonly runId: string;
  readonly json: boolean;
  readonly cwd: string;
}

export async function validateWorkflowCli(
  options: WorkflowCliValidateOptions,
): Promise<void> {
  const result = await validateWorkflowSource({
    cwd: options.cwd,
    sourceFile: options.file,
    allowedProviders: providerNames,
    allowedSandboxes: sandboxNames,
  });

  const output = {
    ok: result.ok,
    meta: result.meta,
    warnings: result.warnings ?? [],
    errors: result.errors ?? [],
  };

  if (options.json) {
    writeJson(output);
  } else if (result.ok) {
    process.stdout.write(
      `Workflow source is valid: ${result.meta?.name ?? options.file}\n`,
    );
  } else {
    process.stderr.write(formatDiagnostics(output.errors));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function stopWorkflowCli(
  options: WorkflowCliControlOptions,
): Promise<void> {
  await requestWorkflowControlCli(options, "stop");
}

export async function pauseWorkflowCli(
  options: WorkflowCliControlOptions,
): Promise<void> {
  await requestWorkflowControlCli(options, "pause");
}

export async function runWorkflowCli(
  options: WorkflowCliRunOptions,
): Promise<void> {
  const argsResult = parseArgsJson(options.argsJson);
  if (!argsResult.ok) {
    writeRunError({
      message: argsResult.message,
      json: options.json,
    });
    return;
  }

  try {
    const hostOverrides = workflowHostOverrides(options);
    const result = await runWorkflow({
      cwd: options.cwd,
      sourceFile: resolve(options.cwd, options.file),
      args: argsResult.value,
      resolveAgentProvider,
      resolveSandbox,
      ...hostOverrides,
    });
    const output = {
      ...result,
      hostOverrides,
    };

    if (options.json) {
      writeJson(output);
    } else {
      process.stdout.write(
        `Workflow ${result.status}: ${result.runId}\nRun directory: ${result.runDir}\n`,
      );
    }

    if (result.status !== "succeeded") {
      process.exitCode = 1;
    }
  } catch (error) {
    writeRunError({
      message: "Workflow run failed before a run record was created.",
      json: options.json,
      error,
    });
  }
}

async function requestWorkflowControlCli(
  options: WorkflowCliControlOptions,
  action: "pause" | "stop",
): Promise<void> {
  const store = new WorkflowRunStore({ cwd: options.cwd });

  try {
    const control =
      action === "stop"
        ? await store.requestStop(options.runId)
        : await store.requestPause(options.runId);
    const state = await store.readState(options.runId);
    const output = {
      runId: options.runId,
      status: state.status,
      control,
      runDir: store.getRunDir(options.runId),
      state,
    };

    if (options.json) {
      writeJson(output);
    } else {
      process.stdout.write(
        `Workflow ${action} requested: ${options.runId}\nRun directory: ${output.runDir}\n`,
      );
    }
  } catch (error) {
    writeControlError({
      runId: options.runId,
      action,
      json: options.json,
      error,
    });
  }
}

function workflowHostOverrides(
  options: WorkflowCliRunOptions,
): Pick<
  WorkflowRunOptions,
  | "provider"
  | "model"
  | "sandbox"
  | "concurrency"
  | "maxAgents"
  | "branchPrefix"
> {
  return {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.concurrency === undefined
      ? {}
      : { concurrency: options.concurrency }),
    ...(options.maxAgents === undefined
      ? {}
      : { maxAgents: options.maxAgents }),
    ...(options.branchPrefix === undefined
      ? {}
      : { branchPrefix: options.branchPrefix }),
  };
}

function parseArgsJson(
  argsJson: string | undefined,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  if (argsJson === undefined) {
    return { ok: true, value: undefined };
  }

  try {
    return { ok: true, value: JSON.parse(argsJson) };
  } catch (error) {
    return {
      ok: false,
      message: `Invalid --args JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function resolveAgentProvider({
  provider,
  model,
}: {
  readonly provider: WorkflowProviderName;
  readonly model?: string;
}): AgentProvider {
  const resolvedModel = model ?? getAgent(provider)?.defaultModel;
  if (resolvedModel === undefined) {
    throw new Error(`Unknown workflow provider: ${provider}`);
  }

  switch (provider) {
    case "claude-code":
      return claudeCode(resolvedModel);
    case "pi":
      return pi(resolvedModel);
    case "codex":
      return codex(resolvedModel);
    case "cursor":
      return cursor(resolvedModel);
    case "opencode":
      return opencode(resolvedModel);
    case "copilot":
      return copilot(resolvedModel);
    default:
      throw new Error(`Unknown workflow provider: ${provider}`);
  }
}

function resolveSandbox({
  sandbox,
}: {
  readonly sandbox: WorkflowSandboxName;
}): SandboxProvider {
  switch (sandbox) {
    case "docker":
      return docker();
    case "podman":
      return podman();
    case "vercel":
      return vercel();
    case "daytona":
      return daytona();
    case "no-sandbox":
      return noSandbox();
    default:
      throw new Error(`Unknown workflow sandbox: ${sandbox}`);
  }
}

function writeControlError(options: {
  readonly runId: string;
  readonly action: "pause" | "stop";
  readonly json: boolean;
  readonly error: unknown;
}) {
  process.exitCode = 1;

  const message = `Workflow ${options.action} request failed.`;
  if (options.json) {
    writeJson({
      runId: options.runId,
      status: "failed",
      control: null,
      runDir: null,
      error: serializeError(options.error, message),
    });
    return;
  }

  process.stderr.write(`${message}\n`);
  process.stderr.write(`${getErrorMessage(options.error)}\n`);
}

function writeRunError(options: {
  readonly message: string;
  readonly json: boolean;
  readonly error?: unknown;
}) {
  process.exitCode = 1;

  const error = options.error ?? new Error(options.message);
  if (options.json) {
    writeJson({
      runId: null,
      status: "failed",
      runDir: null,
      error: serializeError(error, options.message),
      state: null,
    });
    return;
  }

  process.stderr.write(`${options.message}\n`);
  if (options.error !== undefined) {
    process.stderr.write(`${getErrorMessage(options.error)}\n`);
  }
}

function writeJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatDiagnostics(
  errors: readonly { readonly message: string; readonly code: string }[],
) {
  if (errors.length === 0) {
    return "Workflow source validation failed.\n";
  }

  return errors.map((error) => `${error.code}: ${error.message}\n`).join("");
}

function serializeError(error: unknown, fallbackMessage: string) {
  if (error instanceof Error || isErrorLike(error)) {
    return {
      name: typeof error.name === "string" ? error.name : "Error",
      message: error.message,
      stack: typeof error.stack === "string" ? error.stack : undefined,
      details: "details" in error ? error.details : undefined,
    };
  }

  return {
    name: "Error",
    message: fallbackMessage,
    details: error,
  };
}

function isErrorLike(value: unknown): value is {
  readonly name?: unknown;
  readonly message: string;
  readonly stack?: unknown;
  readonly details?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
