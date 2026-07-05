import { createHash } from "node:crypto";
import { basename } from "node:path";
import { extractStructuredOutput } from "../extractStructuredOutput.js";
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
  readonly sourceHash?: string;
  readonly defaultAgent?: AgentProvider;
  readonly defaultSandbox?: SandboxProvider;
  readonly skills?: readonly SkillSpec[];
  readonly store?: WorkflowRunStore;
  readonly resumeFromRunId?: string;
  readonly resumeJournal?: readonly WorkflowAgentJournalEntry[];
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

interface RecordFailureOptions {
  readonly artifacts: WorkflowArtifact[];
  readonly resolved: ResolvedAgentCallOptions;
  readonly callHash: string;
  readonly promptHash: string;
  readonly taskPromptHash: string;
  readonly optionsHash: string;
  readonly startedAt: string;
  readonly branch: string;
  readonly commits: readonly WorkflowCommit[];
  readonly logFilePath?: string;
  readonly sessionId?: string;
  readonly usage?: unknown;
  readonly stdout?: string;
  readonly error: unknown;
}

export class WorkflowAgentRunner {
  readonly cwd: string;
  readonly runId: string;
  readonly branchPrefix: string;
  readonly sourceHash: string;
  readonly defaultAgent?: AgentProvider;
  readonly defaultSandbox?: SandboxProvider;
  readonly skills: readonly SkillSpec[];
  readonly store?: WorkflowRunStore;
  readonly resumeFromRunId?: string;
  readonly resumeJournal: readonly WorkflowAgentJournalEntry[];
  readonly getPhase?: () => string | undefined;
  readonly signal?: AbortSignal;

  readonly #run: WorkflowAgentRunFunction;
  #callIndex = 0;
  #resumeDisabled = false;

  constructor(options: WorkflowAgentRunnerOptions) {
    this.cwd = options.cwd;
    this.runId = options.runId;
    this.branchPrefix = trimSlashes(options.branchPrefix);
    this.sourceHash = options.sourceHash ?? hashString("");
    this.defaultAgent = options.defaultAgent;
    this.defaultSandbox = options.defaultSandbox;
    this.skills = options.skills ?? [];
    this.store = options.store;
    this.resumeFromRunId = options.resumeFromRunId;
    this.resumeJournal = options.resumeJournal ?? [];
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
    const taskPromptHash = hashString(prompt);
    const optionsHash = hashString(
      stableStringify(stableAgentOptionsForHash(options, resolved)),
    );
    const callHash = hashString(
      stableStringify({
        version: 1,
        sourceHash: this.sourceHash,
        label: resolved.label,
        phase: resolved.phase,
        taskPromptHash,
        optionsHash,
      }),
    );
    const artifacts: WorkflowArtifact[] = [];
    const outputDefinition =
      options.schema === undefined
        ? undefined
        : Output.object({
            tag: WORKFLOW_AGENT_OUTPUT_TAG,
            schema: jsonSchemaToStandardSchema(options.schema),
            maxRetries: options.retries,
          });

    await this.#writeArtifact(
      artifacts,
      resolved.callId,
      "prompt",
      wrappedPrompt,
    );

    const replayEntry = this.#findReplayEntry(resolved.callIndex, callHash);
    if (replayEntry !== undefined) {
      return this.#recordReplay<Output>({
        artifacts,
        resolved,
        replayEntry,
        callHash,
        promptHash,
        taskPromptHash,
        optionsHash,
        startedAt,
      });
    }

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
        signal: this.signal,
      });

      const sessionId = getLastSessionId(result);
      const usage = getLastUsage(result);
      let output: Output;

      if (outputDefinition === undefined) {
        output = result.stdout as Output;
      } else {
        try {
          output = await extractStructuredOutput<Output>(
            result.stdout,
            outputDefinition,
            {
              commits: result.commits,
              branch: result.branch,
              preservedWorktreePath: result.preservedWorktreePath,
              sessionId,
              sessionFilePath: getLastSessionFilePath(result),
            },
          );
        } catch (error) {
          return this.#recordFailure({
            artifacts,
            resolved,
            callHash,
            promptHash,
            taskPromptHash,
            optionsHash,
            startedAt,
            branch: result.branch,
            commits: result.commits,
            logFilePath: result.logFilePath,
            sessionId,
            usage,
            stdout: result.stdout,
            error,
          });
        }
      }

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
        taskPromptHash,
        sourceHash: this.sourceHash,
        optionsHash,
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
      return this.#recordFailure({
        artifacts,
        resolved,
        callHash,
        promptHash,
        taskPromptHash,
        optionsHash,
        startedAt,
        branch: getErrorBranch(error) ?? resolved.branch,
        commits: getErrorCommits(error),
        logFilePath: getErrorLogFilePath(error),
        sessionId: getErrorSessionId(error),
        usage: getErrorUsage(error),
        stdout: getErrorStdout(error),
        error,
      });
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

  #findReplayEntry(
    callIndex: number,
    callHash: string,
  ): WorkflowAgentJournalEntry | undefined {
    if (this.#resumeDisabled || this.resumeFromRunId === undefined) {
      return undefined;
    }

    const entry = this.resumeJournal.find(
      (journalEntry) => journalEntry.callIndex === callIndex,
    );

    if (
      entry !== undefined &&
      entry.status === "succeeded" &&
      entry.callHash === callHash
    ) {
      return entry;
    }

    this.#resumeDisabled = true;
    return undefined;
  }

  async #recordReplay<Output>(options: {
    readonly artifacts: WorkflowArtifact[];
    readonly resolved: ResolvedAgentCallOptions;
    readonly replayEntry: WorkflowAgentJournalEntry;
    readonly callHash: string;
    readonly promptHash: string;
    readonly taskPromptHash: string;
    readonly optionsHash: string;
    readonly startedAt: string;
  }): Promise<WorkflowAgentResult<Output>> {
    const replayedFrom = {
      runId: this.resumeFromRunId,
      callId: options.replayEntry.callId,
      callHash: options.replayEntry.callHash,
    };

    await this.#writeArtifact(
      options.artifacts,
      options.resolved.callId,
      "result",
      {
        status: "skipped",
        reason: "replayed",
        replayedFrom,
        output: options.replayEntry.output,
      },
    );
    await this.#writeArtifact(
      options.artifacts,
      options.resolved.callId,
      "run",
      {
        branch: options.replayEntry.branch,
        commits: options.replayEntry.commits,
        logFilePath: options.replayEntry.logFilePath,
        sessionId: options.replayEntry.sessionId,
        usage: options.replayEntry.usage,
        replayedFrom,
      },
    );

    if (options.replayEntry.logFilePath !== undefined) {
      options.artifacts.push({
        name: "log",
        path: options.replayEntry.logFilePath,
      });
    }

    await this.#appendJournal({
      callId: options.resolved.callId,
      callIndex: options.resolved.callIndex,
      callHash: options.callHash,
      label: options.resolved.label,
      phase: options.resolved.phase,
      promptHash: options.promptHash,
      taskPromptHash: options.taskPromptHash,
      sourceHash: this.sourceHash,
      optionsHash: options.optionsHash,
      status: "skipped",
      startedAt: options.startedAt,
      finishedAt: new Date().toISOString(),
      branch: options.replayEntry.branch,
      commits: options.replayEntry.commits,
      logFilePath: options.replayEntry.logFilePath,
      sessionId: options.replayEntry.sessionId,
      usage: options.replayEntry.usage,
      output: options.replayEntry.output,
      replayedFromRunId: this.resumeFromRunId,
      replayedFromCallId: options.replayEntry.callId,
    });

    return {
      output: options.replayEntry.output as Output,
      branch: options.replayEntry.branch,
      commits: options.replayEntry.commits,
      artifacts: options.artifacts,
      sessionId: options.replayEntry.sessionId,
      status: "skipped",
    };
  }

  async #recordFailure<Output>(
    options: RecordFailureOptions,
  ): Promise<WorkflowAgentResult<Output>> {
    const serializedError = serializeError(options.error);

    if (options.stdout !== undefined) {
      await this.#writeArtifact(
        options.artifacts,
        options.resolved.callId,
        "stdout",
        options.stdout,
      );
    }

    await this.#writeArtifact(
      options.artifacts,
      options.resolved.callId,
      "result",
      {
        status: "failed",
        error: serializedError,
      },
    );
    await this.#writeArtifact(
      options.artifacts,
      options.resolved.callId,
      "run",
      {
        branch: options.branch,
        commits: options.commits,
        logFilePath: options.logFilePath,
        sessionId: options.sessionId,
        usage: options.usage,
      },
    );

    if (options.logFilePath !== undefined) {
      options.artifacts.push({ name: "log", path: options.logFilePath });
    }

    await this.#appendJournal({
      callId: options.resolved.callId,
      callIndex: options.resolved.callIndex,
      callHash: options.callHash,
      label: options.resolved.label,
      phase: options.resolved.phase,
      promptHash: options.promptHash,
      taskPromptHash: options.taskPromptHash,
      sourceHash: this.sourceHash,
      optionsHash: options.optionsHash,
      status: "failed",
      startedAt: options.startedAt,
      finishedAt: new Date().toISOString(),
      branch: options.branch,
      commits: options.commits,
      logFilePath: options.logFilePath,
      sessionId: options.sessionId,
      usage: options.usage,
      error: serializedError,
    });

    return {
      branch: options.branch,
      commits: options.commits,
      artifacts: options.artifacts,
      sessionId: options.sessionId,
      status: "failed",
      error: serializedError,
    };
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

function stableAgentOptionsForHash(
  options: WorkflowAgentOptions,
  resolved: ResolvedAgentCallOptions,
): unknown {
  return {
    agent: resolved.agent.name,
    sandbox: resolved.sandbox.name,
    tier: options.tier,
    provider: options.provider,
    model: options.model,
    sandboxName: options.sandboxName,
    isolation: options.isolation,
    readonly: options.readonly,
    skills: resolved.skills.map((skill) => ({
      name: selectableSkillName(skill),
      source: skill.source,
    })),
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    schema: options.schema,
    completionSignal: normalizeCompletionSignal(options.completionSignal),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) {
      sorted[key] = sortJsonValue(item);
    }
  }
  return sorted;
}

function getLastSessionId(result: RunResult): string | undefined {
  return result.iterations.at(-1)?.sessionId;
}

function getLastSessionFilePath(result: RunResult): string | undefined {
  return result.iterations.at(-1)?.sessionFilePath;
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
