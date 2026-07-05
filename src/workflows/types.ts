import type { AgentProvider } from "../AgentProvider.js";
import type { SkillSpec } from "../AgentSkills.js";
import type { SandboxProvider } from "../SandboxProvider.js";
import type { WorkflowAgentRunFunction } from "./WorkflowAgentRunner.js";

export type WorkflowProviderName =
  | "codex"
  | "claude-code"
  | "opencode"
  | "pi"
  | (string & {});

export type WorkflowSandboxName =
  | "docker"
  | "podman"
  | "vercel"
  | "daytona"
  | "no-sandbox"
  | (string & {});

export interface WorkflowMeta {
  readonly name: string;
  readonly description?: string;
  readonly phases?: readonly {
    readonly title: string;
  }[];
}

export interface WorkflowDefaults {
  readonly provider?: WorkflowProviderName;
  readonly model?: string;
  readonly sandbox?: WorkflowSandboxName;
  readonly maxConcurrency?: number;
  readonly maxAgents?: number;
  readonly branchPrefix?: string;
  readonly skills?: readonly string[];
}

/**
 * Workflow-manager runtime resolution for agent provider names declared by
 * workflow defaults, run options, or per-agent call options.
 */
export interface WorkflowAgentProviderResolution {
  readonly provider: WorkflowProviderName;
  readonly model?: string;
  readonly cwd: string;
  readonly runId: string;
}

export type WorkflowAgentProviderResolver = (
  resolution: WorkflowAgentProviderResolution,
) => AgentProvider | Promise<AgentProvider>;

/**
 * Workflow-manager runtime resolution for sandbox names declared by workflow
 * defaults, run options, or per-agent call options.
 */
export interface WorkflowSandboxResolution {
  readonly sandbox: WorkflowSandboxName;
  readonly cwd: string;
  readonly runId: string;
}

export type WorkflowSandboxResolver = (
  resolution: WorkflowSandboxResolution,
) => SandboxProvider | Promise<SandboxProvider>;

export interface WorkflowDefinition<Args = unknown, Result = unknown> {
  readonly meta: WorkflowMeta;
  readonly defaults?: WorkflowDefaults;
  run(ctx: WorkflowContext<Args>): Promise<Result> | Result;
}

export interface WorkflowRunOptions {
  readonly cwd?: string;
  readonly source?: string;
  readonly sourceFile?: string;
  readonly args?: unknown;
  readonly runId?: string;
  readonly runsRoot?: string;
  /** Host override for workflow defaults.provider. Resolved by resolveAgentProvider. */
  readonly provider?: WorkflowProviderName;
  /** Host override for workflow defaults.model. Resolved by resolveAgentProvider. */
  readonly model?: string;
  /** Host override for workflow defaults.sandbox. Resolved by resolveSandbox. */
  readonly sandbox?: WorkflowSandboxName;
  readonly defaultAgent?: AgentProvider;
  readonly defaultSandbox?: SandboxProvider;
  /** Runtime resolver for workflow provider/model names. */
  readonly resolveAgentProvider?: WorkflowAgentProviderResolver;
  /** Runtime resolver for workflow sandbox names. */
  readonly resolveSandbox?: WorkflowSandboxResolver;
  /** Host-provided skill catalog available to workflow agent calls. */
  readonly skills?: readonly SkillSpec[];
  /** Host override for workflow defaults.skills. */
  readonly defaultSkillNames?: readonly string[];
  readonly concurrency?: number;
  readonly maxAgents?: number;
  readonly branchPrefix?: string;
  readonly signal?: AbortSignal;
  /** @internal Test seam for running workflow agent calls without launching a real agent process. */
  readonly agentRun?: WorkflowAgentRunFunction;
}

export interface WorkflowAgentOptions {
  readonly label?: string;
  readonly tier?: "small" | "medium" | "big";
  readonly provider?: WorkflowProviderName;
  readonly model?: string;
  readonly agent?: AgentProvider;
  readonly sandbox?: SandboxProvider;
  readonly sandboxName?: WorkflowSandboxName;
  readonly isolation?: "worktree" | "readonly";
  readonly readonly?: boolean;
  readonly skills?: readonly string[];
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly schema?: JsonSchema;
  readonly completionSignal?: string | readonly string[];
}

export type WorkflowRunStatus =
  | "created"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "succeeded"
  | "failed";

export interface WorkflowRunState {
  readonly id: string;
  readonly status: WorkflowRunStatus;
  readonly meta?: WorkflowMeta;
  readonly cwd: string;
  readonly sourceFile?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly currentPhase?: string;
  readonly agentCount: number;
  readonly maxAgents: number;
  readonly concurrency: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface WorkflowCommit {
  readonly sha: string;
}

export type WorkflowAgentJournalStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface WorkflowAgentJournalEntry {
  readonly callId: string;
  readonly callIndex: number;
  readonly callHash: string;
  readonly label: string;
  readonly phase?: string;
  readonly promptHash: string;
  readonly status: WorkflowAgentJournalStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly branch: string;
  readonly commits: readonly WorkflowCommit[];
  readonly logFilePath?: string;
  readonly sessionId?: string;
  readonly usage?: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
}

export type JsonSchema =
  | JsonStringSchema
  | JsonNumberSchema
  | JsonIntegerSchema
  | JsonBooleanSchema
  | JsonArraySchema
  | JsonObjectSchema;

export interface JsonSchemaBase {
  readonly title?: string;
  readonly description?: string;
}

export interface JsonStringSchema extends JsonSchemaBase {
  readonly type: "string";
  readonly enum?: readonly string[];
}

export interface JsonNumberSchema extends JsonSchemaBase {
  readonly type: "number";
}

export interface JsonIntegerSchema extends JsonSchemaBase {
  readonly type: "integer";
}

export interface JsonBooleanSchema extends JsonSchemaBase {
  readonly type: "boolean";
}

export interface JsonArraySchema extends JsonSchemaBase {
  readonly type: "array";
  readonly items?: JsonSchema;
}

export interface JsonObjectSchema extends JsonSchemaBase {
  readonly type: "object";
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly additionalProperties?: boolean | JsonSchema;
}

export type WorkflowTask<T = unknown> = () => Promise<T> | T;

export interface WorkflowParallelOptions {
  readonly concurrency?: number;
}

export interface WorkflowAgentCall {
  readonly prompt: string;
  readonly options?: WorkflowAgentOptions;
}

export interface WorkflowAgentInvoker {
  <Output = unknown>(
    prompt: string,
    options?: WorkflowAgentOptions,
  ): Promise<WorkflowAgentResult<Output>>;
  run<Output = unknown>(
    prompt: string,
    options?: WorkflowAgentOptions,
  ): Promise<WorkflowAgentResult<Output>>;
}

export interface WorkflowParallelRunner {
  <T>(
    tasks: readonly WorkflowTask<T>[],
    options?: WorkflowParallelOptions,
  ): Promise<T[]>;
  agents<Output = unknown>(
    calls: readonly WorkflowAgentCall[],
    options?: WorkflowParallelOptions,
  ): Promise<WorkflowAgentResult<Output>[]>;
}

export interface WorkflowPipelineRunner {
  <T>(steps: readonly WorkflowTask<T>[]): Promise<T[]>;
}

export interface WorkflowPhaseReporter {
  (title: string): Promise<void> | void;
  current(): string | undefined;
}

export interface WorkflowLogger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
  event(event: Omit<WorkflowEvent, "timestamp">): void;
}

export interface WorkflowValidator {
  <Value = unknown>(
    value: unknown,
    schema: JsonSchema,
  ): WorkflowValidationResult<Value>;
}

export interface WorkflowRuntime {
  readonly id: string;
  readonly cwd: string;
  readonly sourceFile?: string;
  state(): WorkflowRunState;
  stop(reason?: string): Promise<void> | void;
}

export interface WorkflowBudget {
  readonly maxAgents: number;
  readonly agentCount: number;
  readonly concurrency: number;
  remainingAgents(): number;
}

export interface WorkflowContext<Args = unknown> {
  readonly args: Args;
  readonly agent: WorkflowAgentInvoker;
  readonly parallel: WorkflowParallelRunner;
  readonly pipeline: WorkflowPipelineRunner;
  readonly phase: WorkflowPhaseReporter;
  readonly log: WorkflowLogger;
  readonly validate: WorkflowValidator;
  readonly workflow: WorkflowRuntime;
  readonly budget: WorkflowBudget;
}

export type WorkflowAgentResultStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "stopped";

export interface WorkflowArtifact {
  readonly name: string;
  readonly path?: string;
  readonly value?: unknown;
}

export interface WorkflowAgentResult<Output = unknown> {
  readonly output?: Output;
  readonly branch: string;
  readonly commits: readonly WorkflowCommit[];
  readonly artifacts: readonly WorkflowArtifact[];
  readonly sessionId?: string;
  readonly status: WorkflowAgentResultStatus;
  readonly error?: unknown;
}

export type WorkflowDiagnosticSeverity = "error" | "warning";

export interface WorkflowDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly severity?: WorkflowDiagnosticSeverity;
  readonly details?: unknown;
}

export interface WorkflowValidationResult<Value = unknown> {
  readonly ok: boolean;
  readonly value?: Value;
  readonly meta?: WorkflowMeta;
  readonly errors?: readonly WorkflowDiagnostic[];
  readonly warnings?: readonly WorkflowDiagnostic[];
}

export interface WorkflowEvent {
  readonly timestamp: string;
  readonly type: string;
  readonly message?: string;
  readonly details?: unknown;
}
