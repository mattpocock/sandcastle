import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Output } from "../Output.js";
import {
  run as sandcastleRun,
  type RunOptions,
  type RunResult,
} from "../run.js";
import type { AgentProvider } from "../AgentProvider.js";
import type { SkillSpec } from "../AgentSkills.js";
import type { SandboxProvider } from "../SandboxProvider.js";
import { WorkflowValidationError } from "./errors.js";
import { jsonSchemaToStandardSchema } from "./JsonSchemaStandardSchema.js";
import { sanitizeWorkflowName } from "./sanitizeWorkflowName.js";
import type {
  JsonSchema,
  WorkflowAgentJournalEntry,
  WorkflowAgentOptions,
  WorkflowAgentResult,
  WorkflowArtifact,
  WorkflowCommit,
} from "./types.js";
import type { WorkflowRunStore } from "./WorkflowRunStore.js";

export const WORKFLOW_AGENT_OUTPUT_TAG = "workflow_output";

export type WorkflowAgentRunFunction = <Output = unknown>(
  options: RunOptions,
) => Promise<RunResult & { readonly output?: Output }>;

export interface WorkflowAgentRunnerOptions {
  readonly cwd: string;
  readonly runId: string;
  readonly branchPrefix: string;
  readonly defaultAgent?: AgentProvider;
  readonly defaultSandbox?: SandboxProvider;
  readonly skills?: readonly SkillSpec[];
  readonly store?: WorkflowRunStore;
  readonly run?: WorkflowAgentRunFunction;
  readonly getPhase?: () => string | undefined;
  readonly signal?: AbortSignal;
}

interface ResolvedAgentCallOptions {
  readonly agent: AgentProvider;
  readonly sandbox: SandboxProvider;
  readonly label: string;
  readonly phase?: string;
  readonly branch: string;
  readonly callId: string;
  readonly callIndex: number;
  readonly skills: readonly SkillSpec[];
}

export class WorkflowAgentRunner {
  readonly cwd: string;
  readonly runId: string;
  readonly branchPrefix: string;
  readonly defaultAgent?: AgentProvider;
  readonly defaultSandbox?: SandboxProvider;
  readonly skills: readonly SkillSpec[];
  readonly store?: WorkflowRunStore;
  readonly getPhase?: () => string | undefined;
  readonly signal?: AbortSignal;

  readonly #run: WorkflowAgentRunFunction;
  #callIndex = 0;

  constructor(options: WorkflowAgentRunnerOptions) {
    this.cwd = options.cwd;
    this.runId = options.runId;
    this.branchPrefix = trimSlashes(options.branchPrefix);
    this.defaultAgent = options.defaultAgent;
    this.defaultSandbox = options.defaultSandbox;
    this.skills = options.skills ?? [];
    this.store = options.store;
    this.#run = options.run ?? sandcastleRun;
    this.getPhase = options.getPhase;
    this.signal = options.signal;
  }

  async run<Output = unknown>(
    prompt: string,
    options: WorkflowAgentOptions = {},
  ): Promise<WorkflowAgentResult<Output>> {
    const startedAt = new Date().toISOString();
    const resolved = this.#resolveOptions(options);
    const wrappedPrompt = wrapWorkflowAgentPrompt({
      runId: this.runId,
      callId: resolved.callId,
      phase: resolved.phase,
      label: resolved.label,
      prompt,
      schema: options.schema,
    });
    const promptHash = hashString(wrappedPrompt);
    const callHash = hashString(
      JSON.stringify({
        runId: this.runId,
        callId: resolved.callId,
        label: resolved.label,
        phase: resolved.phase,
        promptHash,
      }),
    );
    const artifacts: WorkflowArtifact[] = [];

    await this.#writeArtifact(
      artifacts,
      resolved.callId,
      "prompt",
      wrappedPrompt,
    );

    try {
      const result = await this.#run<Output>({
        cwd: this.cwd,
        agent: resolved.agent,
        sandbox: resolved.sandbox,
        prompt: wrappedPrompt,
        maxIterations: 1,
        name: resolved.label,
        skills: resolved.skills,
        branchStrategy: { type: "branch", branch: resolved.branch },
        completionSignal: normalizeCompletionSignal(options.completionSignal),
        idleTimeoutSeconds:
          options.timeoutMs === undefined
            ? undefined
            : Math.ceil(options.timeoutMs / 1000),
        output:
          options.schema === undefined
            ? undefined
            : Output.object({
                tag: WORKFLOW_AGENT_OUTPUT_TAG,
                schema: jsonSchemaToStandardSchema(options.schema),
                maxRetries: options.retries,
              }),
        signal: this.signal,
      });

      const output =
        options.schema === undefined
          ? (result.stdout as Output)
          : (result.output as Output);
      const sessionId = getLastSessionId(result);
      const usage = getLastUsage(result);

      await this.#writeArtifact(
        artifacts,
        resolved.callId,
        "stdout",
        result.stdout,
      );
      await this.#writeArtifact(artifacts, resolved.callId, "result", output);
      await this.#writeArtifact(artifacts, resolved.callId, "run", {
        branch: result.branch,
        commits: result.commits,
        logFilePath: result.logFilePath,
        sessionId,
        usage,
      });

      if (result.logFilePath !== undefined) {
        artifacts.push({ name: "log", path: result.logFilePath });
      }

      await this.#appendJournal({
        callId: resolved.callId,
        callIndex: resolved.callIndex,
        callHash,
        label: resolved.label,
        phase: resolved.phase,
        promptHash,
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        branch: result.branch,
        commits: result.commits,
        logFilePath: result.logFilePath,
        sessionId,
        usage,
        output,
      });

      return {
        output,
        branch: result.branch,
        commits: result.commits,
        artifacts,
        sessionId,
        status: "succeeded",
      };
    } catch (error) {
      const serializedError = serializeError(error);
      const branch = getErrorBranch(error) ?? resolved.branch;
      const commits = getErrorCommits(error);
      const sessionId = getErrorSessionId(error);
      const logFilePath = getErrorLogFilePath(error);
      const usage = getErrorUsage(error);
      const stdout = getErrorStdout(error);

      if (stdout !== undefined) {
        await this.#writeArtifact(artifacts, resolved.callId, "stdout", stdout);
      }

      await this.#writeArtifact(artifacts, resolved.callId, "result", {
        status: "failed",
        error: serializedError,
      });
      await this.#writeArtifact(artifacts, resolved.callId, "run", {
        branch,
        commits,
        logFilePath,
        sessionId,
        usage,
      });

      if (logFilePath !== undefined) {
        artifacts.push({ name: "log", path: logFilePath });
      }

      await this.#appendJournal({
        callId: resolved.callId,
        callIndex: resolved.callIndex,
        callHash,
        label: resolved.label,
        phase: resolved.phase,
        promptHash,
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        branch,
        commits,
        logFilePath,
        sessionId,
        usage,
        error: serializedError,
      });

      return {
        branch,
        commits,
        artifacts,
        sessionId,
        status: "failed",
        error: serializedError,
      };
    }
  }

  #resolveOptions(options: WorkflowAgentOptions): ResolvedAgentCallOptions {
    const agent = options.agent ?? this.defaultAgent;
    if (agent === undefined) {
      throw new WorkflowValidationError(
        "Workflow agent call requires an agent provider. Pass options.agent or configure defaultAgent.",
      );
    }

    const sandbox = options.sandbox ?? this.defaultSandbox;
    if (sandbox === undefined) {
      throw new WorkflowValidationError(
        "Workflow agent call requires a sandbox provider. Pass options.sandbox or configure defaultSandbox.",
      );
    }

    const callIndex = this.#callIndex++;
    const label = options.label ?? "agent";
    const callId = `${String(callIndex + 1).padStart(3, "0")}-${sanitizeWorkflowName(
      label,
    )}`;
    const branch = [this.branchPrefix, this.runId, callId]
      .filter((part) => part !== "")
      .join("/");

    return {
      agent,
      sandbox,
      label,
      phase: this.getPhase?.(),
      branch,
      callId,
      callIndex,
      skills: selectSkills(this.skills, options.skills),
    };
  }

  async #writeArtifact(
    artifacts: WorkflowArtifact[],
    callId: string,
    name: "prompt" | "result" | "stdout" | "run",
    value: unknown,
  ): Promise<void> {
    if (this.store === undefined) {
      return;
    }

    const path = await this.store.writeAgentArtifact(
      this.runId,
      callId,
      name,
      value,
    );
    artifacts.push({ name, path });
  }

  async #appendJournal(entry: WorkflowAgentJournalEntry): Promise<void> {
    if (this.store === undefined) {
      return;
    }

    await this.store.appendJournal(this.runId, entry);
  }
}

export function createWorkflowAgentRunner(
  options: WorkflowAgentRunnerOptions,
): WorkflowAgentRunner {
  return new WorkflowAgentRunner(options);
}

export interface WorkflowAgentPromptOptions {
  readonly runId: string;
  readonly callId: string;
  readonly phase?: string;
  readonly label: string;
  readonly prompt: string;
  readonly schema?: JsonSchema;
}

export function wrapWorkflowAgentPrompt(
  options: WorkflowAgentPromptOptions,
): string {
  const contextLines = [
    "# Workflow Runtime Context",
    "",
    `- Run ID: ${options.runId}`,
    `- Agent call ID: ${options.callId}`,
    `- Label: ${options.label}`,
    `- Phase: ${options.phase ?? "none"}`,
    "",
    "# Safety",
    "",
    "- Work only on the requested workflow agent task.",
    "- Do not modify workflow run artifacts under .sandcastle/runs.",
    "- Do not use destructive git operations unless the task explicitly requires them.",
    "- Keep changes scoped and report blockers in the final output.",
  ];

  if (options.schema !== undefined) {
    contextLines.push(
      "",
      "# Structured Output",
      "",
      `Emit exactly one <${WORKFLOW_AGENT_OUTPUT_TAG}> tag containing JSON that matches this schema.`,
      `Do not emit any other <${WORKFLOW_AGENT_OUTPUT_TAG}> tag.`,
      "",
      JSON.stringify(options.schema, null, 2),
    );
  }

  return `${contextLines.join("\n")}\n\n# Task\n\n${options.prompt}`;
}

function selectSkills(
  availableSkills: readonly SkillSpec[],
  requestedNames?: readonly string[],
): readonly SkillSpec[] {
  if (requestedNames === undefined) {
    return availableSkills;
  }

  const skillsByName = new Map<string, SkillSpec[]>();
  for (const skill of availableSkills) {
    const name = selectableSkillName(skill);
    const existing = skillsByName.get(name);
    if (existing === undefined) {
      skillsByName.set(name, [skill]);
    } else {
      existing.push(skill);
    }
  }

  const selected: SkillSpec[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];

  for (const name of requestedNames) {
    const skills = skillsByName.get(name);
    if (skills === undefined) {
      missing.push(name);
    } else if (skills.length > 1) {
      ambiguous.push(name);
    } else {
      selected.push(skills[0]!);
    }
  }

  if (ambiguous.length > 0) {
    throw new WorkflowValidationError(
      `Workflow agent call requested ambiguous skill${
        ambiguous.length === 1 ? "" : "s"
      }: ${ambiguous.join(", ")}.`,
      {
        details: {
          requested: requestedNames,
          ambiguous,
          available: Array.from(skillsByName.keys()),
        },
      },
    );
  }

  if (missing.length > 0) {
    throw new WorkflowValidationError(
      `Workflow agent call requested unavailable skill${
        missing.length === 1 ? "" : "s"
      }: ${missing.join(", ")}.`,
      {
        details: {
          requested: requestedNames,
          available: Array.from(skillsByName.keys()),
        },
      },
    );
  }

  return selected;
}

function selectableSkillName(skill: SkillSpec): string {
  return skill.name ?? basename(skill.source);
}

function normalizeCompletionSignal(
  completionSignal: WorkflowAgentOptions["completionSignal"],
): string | string[] | undefined {
  if (completionSignal === undefined || typeof completionSignal === "string") {
    return completionSignal;
  }

  return [...completionSignal];
}

function getLastSessionId(result: RunResult): string | undefined {
  return result.iterations.at(-1)?.sessionId;
}

function getLastUsage(result: RunResult): unknown {
  return result.iterations.at(-1)?.usage;
}

function getErrorBranch(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.branch === "string") {
    return error.branch;
  }
  return undefined;
}

function getErrorCommits(error: unknown): readonly WorkflowCommit[] {
  if (isRecord(error) && Array.isArray(error.commits)) {
    return error.commits.filter(isWorkflowCommit);
  }
  return [];
}

function getErrorSessionId(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.sessionId === "string") {
    return error.sessionId;
  }
  return undefined;
}

function getErrorLogFilePath(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.logFilePath === "string") {
    return error.logFilePath;
  }
  return undefined;
}

function getErrorUsage(error: unknown): unknown {
  if (!isRecord(error)) {
    return undefined;
  }

  if ("usage" in error) {
    return error.usage;
  }

  if (Array.isArray(error.iterations)) {
    const lastIteration = error.iterations.filter(isRecord).at(-1);
    return lastIteration?.usage;
  }

  return undefined;
}

function getErrorStdout(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.stdout === "string") {
    return error.stdout;
  }
  return undefined;
}

function isWorkflowCommit(value: unknown): value is WorkflowCommit {
  return isRecord(value) && typeof value.sha === "string";
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

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
