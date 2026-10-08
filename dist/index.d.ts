import { B as BindMountSandboxHandle, S as SandboxProvider, a as BranchStrategy, A as AnySandboxProvider, E as ExecResult, M as MergeToHeadBranchStrategy, b as NamedBranchStrategy } from './SandboxProvider-EkSMuBp8.js';
export { c as BindMountBranchStrategy, d as BindMountCreateOptions, e as BindMountSandboxProvider, f as BindMountSandboxProviderConfig, H as HeadBranchStrategy, g as InteractiveExecOptions, h as IsolatedBranchStrategy, i as IsolatedCreateOptions, j as IsolatedSandboxHandle, I as IsolatedSandboxProvider, k as IsolatedSandboxProviderConfig, l as NoSandboxBranchStrategy, m as NoSandboxHandle, N as NoSandboxProvider, n as createBindMountSandboxProvider, o as createIsolatedSandboxProvider } from './SandboxProvider-EkSMuBp8.js';
import { StandardSchemaV1 } from '@standard-schema/spec';
export { M as MountConfig } from './MountConfig-CmXclHA5.js';

/**
 * Session JSONL transfer primitives.
 *
 * The transfer functions are pure: they take a JSONL string and the source/
 * target cwds, and return the rewritten JSONL string. Call sites do their own
 * file I/O (reading the source, writing the destination). Per ADR 0012, the
 * cwd rewrite is specific to each agent's JSONL format, so each agent owns
 * its own transfer function.
 */

/**
 * Result of locating a session on the host by its unique id, independent of any
 * cwd-derived path encoding.
 */
interface HostSessionLookup {
    /** Absolute path to the located session file, or `undefined` when no session
     *  with this id exists anywhere under the searched root. */
    readonly path: string | undefined;
    /** The host directory that was scanned — surfaced in not-found errors so the
     *  user knows where Sandcastle looked. */
    readonly searchedRoot: string;
}
/**
 * Encode a cwd into the Claude Code `~/.claude/projects/<encoded>/` layout.
 * Replaces path separators with hyphens, matching Claude Code's convention.
 */
declare const encodeProjectPath: (cwd: string) => string;
/** Absolute host path to a Claude session JSONL file. */
declare const claudeHostSessionPath: (cwd: string, id: string, projectsDir?: string) => string;
/** Sandbox-side path to a Claude session JSONL file (always POSIX separators). */
declare const claudeSandboxSessionPath: (cwd: string, id: string, projectsDir: string) => string;
/**
 * Locate a Claude Code session JSONL on the host by its unique id, scanning each
 * `~/.claude/projects/<encoded-cwd>/` directory rather than reconstructing the
 * cwd encoding. The session id is globally unique, so the first match wins.
 */
declare const findClaudeSessionOnHost: (id: string, projectsDir?: string) => Promise<HostSessionLookup>;
/**
 * Rewrite a Claude Code session JSONL string, replacing `cwd` fields that
 * match `fromCwd` with `toCwd`. Pure function — no file I/O.
 */
declare const transferClaudeSession: (jsonl: string, fromCwd: string, toCwd: string) => string;
/**
 * Locate a Codex session rollout file on the host by its id, reusing the
 * date-nested scan.
 */
declare const findCodexSessionOnHost: (id: string, sessionsDir?: string) => Promise<HostSessionLookup>;
/**
 * Rewrite a Codex session JSONL string, replacing `cwd` fields (both top-level
 * and `session_meta.payload.cwd`) that match `fromCwd` with `toCwd`. Pure
 * function — no file I/O.
 */
declare const transferCodexSession: (jsonl: string, fromCwd: string, toCwd: string) => string;

type ParsedStreamEvent = {
    type: "text";
    text: string;
} | {
    type: "result";
    result: string;
} | {
    type: "tool_call";
    name: string;
    args: string;
} | {
    type: "session_id";
    sessionId: string;
} | {
    type: "usage";
    usage: IterationUsage;
};
/** Options passed to buildPrintCommand and buildInteractiveArgs. */
interface AgentCommandOptions {
    readonly prompt: string;
    readonly dangerouslySkipPermissions: boolean;
    /** When set, the agent should resume the given session ID instead of starting fresh. */
    readonly resumeSession?: string;
    /**
     * When true alongside `resumeSession`, the agent should fork the session
     * instead of mutating it — Claude's `--fork-session`, Codex's
     * `codex exec fork`. The parent session JSONL is left intact and the agent
     * writes a new session under a fresh id.
     */
    readonly forkSession?: boolean;
}
/** Return type of buildPrintCommand — command string plus optional stdin content.
 *  When `stdin` is set, the sandbox pipes it to the child process's stdin
 *  instead of inlining the prompt in argv, avoiding the Linux 128 KB per-arg limit. */
interface PrintCommand {
    readonly command: string;
    readonly stdin?: string;
}
/** Per-iteration token usage snapshot extracted from the agent session. */
interface IterationUsage {
    readonly inputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly cacheReadInputTokens: number;
    readonly outputTokens: number;
}
interface AgentSessionStorage {
    /** Transfer a session JSONL from the sandbox into the host store. */
    captureToHost(args: {
        hostCwd: string;
        sandboxCwd: string;
        sessionId: string;
        handle: BindMountSandboxHandle;
    }): Promise<void>;
    /** Transfer a session JSONL from the host store into the sandbox. */
    resumeIntoSandbox(args: {
        hostCwd: string;
        sandboxCwd: string;
        sessionId: string;
        handle: BindMountSandboxHandle;
    }): Promise<void>;
    /** Read a captured session JSONL from the host store. Returns undefined when absent. */
    readHostSession(cwd: string, sessionId: string): Promise<string | undefined>;
    /** Whether a session with the given id exists in the host store keyed on cwd. */
    existsOnHost(cwd: string, sessionId: string): Promise<boolean>;
    /** Absolute host path where a session would be stored (for not-found error messages). */
    hostSessionFilePath(cwd: string, sessionId: string): string | undefined;
    /**
     * Locate a session on the host by its unique id, independent of cwd encoding.
     * Used by the no-sandbox resume precheck, where the agent runs on the host and
     * writes the session in place under a cwd-derived directory Sandcastle cannot
     * reliably reconstruct. Returns the located path (or `undefined`) plus the
     * directory that was searched (for not-found errors).
     */
    findByIdOnHost(sessionId: string): Promise<HostSessionLookup>;
}
interface AgentProvider {
    readonly name: string;
    /** Environment variables injected by this agent provider. Merged at launch time with env resolver and sandbox provider env. */
    readonly env: Record<string, string>;
    /** When true, session capture is enabled for this provider. Default: true for Claude Code, false for others. */
    readonly captureSessions: boolean;
    /** Provider-owned storage and transfer behavior for resumable agent sessions. */
    readonly sessionStorage?: AgentSessionStorage;
    buildPrintCommand(options: AgentCommandOptions): PrintCommand;
    buildInteractiveArgs?(options: AgentCommandOptions): string[];
    parseStreamLine(line: string): ParsedStreamEvent[];
    /** Parse token usage from the captured session JSONL content. Only implemented by Claude Code. */
    parseSessionUsage?(content: string): IterationUsage | undefined;
}
/** Options for the pi agent provider. */
interface PiOptions {
    /** Reasoning effort level. Maps to the CLI's --thinking flag. */
    readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    /** Environment variables injected by this agent provider. */
    readonly env?: Record<string, string>;
    /** When false, session capture is disabled. Default: true. */
    readonly captureSessions?: boolean;
    /** Override pi session directories for tests or non-standard installs. */
    readonly sessionStorage?: {
        readonly hostSessionsDir?: string;
        readonly sandboxSessionsDir?: string;
    };
}
declare const pi: (model: string, options?: PiOptions) => AgentProvider & {
    readonly sessionStorage: AgentSessionStorage;
};
/** Options for the codex agent provider. */
interface CodexOptions {
    readonly effort?: "low" | "medium" | "high" | "xhigh";
    /** Environment variables injected by this agent provider. */
    readonly env?: Record<string, string>;
    /** When false, session capture is disabled. Default: true. */
    readonly captureSessions?: boolean;
    /** Override Codex session directories for tests or non-standard installs. */
    readonly sessionStorage?: {
        readonly hostSessionsDir?: string;
        readonly sandboxSessionsDir?: string;
    };
    /**
     * Maps to Codex's `approvals_reviewer` config key (set via
     * `-c approvals_reviewer="<value>"`). When set to `"auto_review"`, the
     * provider swaps the default `--dangerously-bypass-approvals-and-sandbox`
     * for an interactive approval policy (`-a on-request`) and Codex's most
     * permissive sandbox (`-s danger-full-access`) — auto-review needs
     * something to review, and the safety boundary is the reviewer agent
     * rather than the filesystem sandbox.
     */
    readonly approvalsReviewer?: "user" | "auto_review";
}
declare const codex: (model: string, options?: CodexOptions) => AgentProvider & {
    readonly sessionStorage: AgentSessionStorage;
};
/** Options for the cursor agent provider. */
interface CursorOptions {
    /** Environment variables injected by this agent provider. */
    readonly env?: Record<string, string>;
}
declare const cursor: (model: string, options?: CursorOptions) => AgentProvider;
/** Options for the opencode agent provider. */
interface OpenCodeOptions {
    /** Provider-specific reasoning effort variant (e.g. "high", "max", "low", "minimal"). */
    readonly variant?: string;
    /**
     * Named OpenCode agent/mode to run, mapped to OpenCode's own `--agent` flag
     * (e.g. "build", "plan"). This is distinct from Sandcastle's `--agent`
     * provider selector — it chooses an agent *inside* OpenCode.
     */
    readonly agent?: string;
    /** Environment variables injected by this agent provider. */
    readonly env?: Record<string, string>;
}
declare const opencode: (model: string, options?: OpenCodeOptions) => AgentProvider;
/** Options for the GitHub Copilot CLI agent provider. */
interface CopilotOptions {
    /** Reasoning effort level. Maps to the CLI's --effort flag. */
    readonly effort?: "low" | "medium" | "high";
    /** Environment variables injected by this agent provider. */
    readonly env?: Record<string, string>;
}
declare const copilot: (model: string, options?: CopilotOptions) => AgentProvider;
interface ClaudeCodeOptions {
    readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
    /** Environment variables injected by this agent provider. */
    readonly env?: Record<string, string>;
    /** When false, session capture is disabled. Default: true. */
    readonly captureSessions?: boolean;
    /** Override Claude session directories for tests or non-standard installs. */
    readonly sessionStorage?: {
        readonly hostProjectsDir?: string;
        readonly sandboxProjectsDir?: string;
    };
    /**
     * Maps directly to Claude's `--permission-mode` flag. When set, replaces the
     * default `--dangerously-skip-permissions` Sandcastle passes on AFK runs —
     * the two flags are mutually exclusive on Claude's CLI. Use `"auto"` for
     * AI-mediated per-tool approve/deny on unsandboxed host runs.
     */
    readonly permissionMode?: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
    /**
     * Raw CLI flags appended verbatim after every flag Sandcastle itself emits,
     * before the trailing prompt delivery. Escape hatch for flags Sandcastle
     * doesn't model yet (e.g. `--strict-mcp-config`, `--mcp-config`, `--settings`).
     * Pass flag and value as separate array entries — each entry is shell-escaped
     * independently in print mode, so a pre-joined string breaks escaping.
     */
    readonly extraArgs?: readonly string[];
}
declare const claudeCode: (model: string, options?: ClaudeCodeOptions) => AgentProvider & {
    readonly sessionStorage: AgentSessionStorage;
};

/**
 * A single event in the agent's output stream, surfaced to callers of `run()`
 * so they can forward it to their own observability system.
 *
 * Emitted only in log-to-file mode when an `onAgentStreamEvent` callback is
 * provided via `logging`. See `run()`.
 *
 * The `"raw"` variant carries every stdout line the agent emits, verbatim and
 * before parsing — including lines that the provider's stream parser would
 * otherwise drop (e.g. tool-use blocks for unrecognised tools). Intended for
 * debugging when the typed `"text"` / `"toolCall"` events don't surface
 * enough detail.
 */
type AgentStreamEvent = {
    readonly type: "text";
    readonly message: string;
    readonly iteration: number;
    readonly timestamp: Date;
} | {
    readonly type: "toolCall";
    readonly name: string;
    readonly formattedArgs: string;
    readonly iteration: number;
    readonly timestamp: Date;
} | {
    readonly type: "raw";
    readonly line: string;
    readonly iteration: number;
    readonly timestamp: Date;
};

type SandboxHooks = {
    readonly host?: {
        readonly onWorktreeReady?: ReadonlyArray<{
            readonly command: string;
            readonly timeoutMs?: number;
        }>;
        readonly onSandboxReady?: ReadonlyArray<{
            readonly command: string;
            readonly timeoutMs?: number;
        }>;
    };
    readonly sandbox?: {
        readonly onSandboxReady?: ReadonlyArray<{
            readonly command: string;
            readonly sudo?: boolean;
            readonly timeoutMs?: number;
        }>;
    };
};

/** Per-iteration result carrying an optional session ID. */
interface IterationResult {
    /** Claude Code session ID extracted from the init line, or undefined for non-Claude agents. */
    readonly sessionId?: string;
    /** Absolute host path to the captured session JSONL, or undefined when capture is disabled or provider is non-Claude. */
    readonly sessionFilePath?: string;
    /** Token usage snapshot from the last assistant message in the session, or undefined when capture is disabled or provider does not support usage parsing. */
    readonly usage?: IterationUsage;
}

/**
 * A map of named values used for prompt argument substitution.
 * Each key corresponds to a `{{KEY}}` placeholder in the prompt; the value
 * replaces it before the prompt is passed to the agent.
 */
type PromptArgs = Record<string, string | number | boolean>;

/** Branded output definition for `Output.object({ tag, schema })`. */
interface OutputObjectDefinition<T> {
    readonly _tag: "object";
    readonly tag: string;
    readonly schema: StandardSchemaV1<unknown, T>;
    /**
     * Maximum number of additional attempts after the first if structured output
     * extraction or validation fails. Each retry resumes the failed run's agent
     * session and feeds back a token-efficient description of the error so the
     * agent can re-emit a corrected tag. Default: `0` (no retries).
     *
     * Retries require the agent provider to support session resumption (i.e.
     * `provider.sessionStorage` is populated — Claude Code, Codex, Pi). `run()`
     * fails at entry with a clear error when retries are requested but the
     * provider cannot resume.
     */
    readonly maxRetries?: number;
}
/** Branded output definition for `Output.string({ tag })`. */
interface OutputStringDefinition {
    readonly _tag: "string";
    readonly tag: string;
    /**
     * Maximum number of additional attempts after the first if structured output
     * extraction fails. Each retry resumes the failed run's agent session and
     * feeds back a token-efficient description of the error so the agent can
     * re-emit a corrected tag. Default: `0` (no retries).
     *
     * Retries require the agent provider to support session resumption (i.e.
     * `provider.sessionStorage` is populated — Claude Code, Codex, Pi). `run()`
     * fails at entry with a clear error when retries are requested but the
     * provider cannot resume.
     */
    readonly maxRetries?: number;
}
/** Union of all output definition shapes accepted by `run()`. */
type OutputDefinition = OutputObjectDefinition<any> | OutputStringDefinition;
/**
 * Helpers for declaring structured output on `run()`.
 *
 * ```ts
 * import { Output, run } from "@ai-hero/sandcastle";
 * import { z } from "zod";
 *
 * const result = await run({
 *   output: Output.object({ tag: "result", schema: z.object({ answer: z.number() }) }),
 *   // ...
 * });
 * console.log(result.output.answer); // typed as number
 * ```
 */
declare const Output: {
    /**
     * Declare an object-typed structured output extracted from an XML tag in
     * the agent's stdout. The tag contents are JSON-parsed (with fence-aware
     * unwrapping) and validated against the provided Standard Schema validator.
     *
     * Set `maxRetries` to have `run()` automatically resume the failed session
     * and ask the agent to re-emit corrected output when extraction or
     * validation fails. Default: `0` (no retries).
     */
    readonly object: <Schema extends StandardSchemaV1>(opts: {
        tag: string;
        schema: Schema;
        maxRetries?: number;
    }) => OutputObjectDefinition<StandardSchemaV1.InferOutput<Schema>>;
    /**
     * Declare a string-typed structured output extracted from an XML tag in
     * the agent's stdout. The tag contents are whitespace-trimmed and returned
     * as a plain string — no JSON parsing, no schema validation.
     *
     * Set `maxRetries` to have `run()` automatically resume the failed session
     * and ask the agent to re-emit corrected output when extraction fails.
     * Default: `0` (no retries).
     */
    readonly string: (opts: {
        tag: string;
        maxRetries?: number;
    }) => OutputStringDefinition;
};
interface StructuredOutputErrorOptions {
    readonly tag: string;
    readonly rawMatched: string | undefined;
    readonly cause?: unknown;
    readonly commits: {
        sha: string;
    }[];
    readonly branch: string;
    readonly preservedWorktreePath?: string;
    readonly sessionId?: string;
    readonly sessionFilePath?: string;
}
/**
 * Thrown by `run()` when structured output extraction or validation fails.
 *
 * Possible failure modes:
 * - The configured XML tag was not found in stdout (`rawMatched` is `undefined`).
 * - The tag contents failed `JSON.parse` (`cause` carries the parse error).
 * - The parsed JSON failed schema validation (`cause` carries the Standard Schema issues).
 *
 * The error carries `commits`, `branch`, and optionally `preservedWorktreePath`
 * so callers can decide recovery without losing the run's side effects.
 *
 * It also carries `sessionId` (and `sessionFilePath` when the session was
 * captured to the host) of the iteration that produced the bad output, so a
 * caller can resume that same session and ask the agent to re-emit corrected
 * output:
 *
 * ```ts
 * try {
 *   return await run({ ...opts, output });
 * } catch (e) {
 *   if (e instanceof StructuredOutputError && e.sessionId) {
 *     return await run({
 *       ...opts,
 *       output,
 *       resumeSession: e.sessionId,
 *       prompt: feedback(e),
 *     });
 *   }
 *   throw e;
 * }
 * ```
 */
declare class StructuredOutputError extends Error {
    readonly tag: string;
    readonly rawMatched: string | undefined;
    readonly cause: unknown;
    readonly commits: {
        sha: string;
    }[];
    readonly branch: string;
    readonly preservedWorktreePath?: string;
    /** Session ID of the iteration that produced the bad output, when available. */
    readonly sessionId?: string;
    /** Host path to the captured session JSONL, when the session was captured. */
    readonly sessionFilePath?: string;
    constructor(message: string, options: StructuredOutputErrorOptions);
}

/**
 * Controls where Sandcastle writes iteration progress and agent output.
 * Use `"file"` (log-to-file mode) to write to a log file on disk, or
 * `"stdout"` (terminal mode) to render an interactive UI in the terminal.
 */
type LoggingOption = 
/** Write progress and agent output to a log file at the given path (log-to-file mode). */
{
    readonly type: "file";
    readonly path: string;
    /**
     * Optional callback invoked for each agent stream event (text chunk,
     * tool call, or raw stdout line) in addition to being written to the
     * log file. Intended for forwarding the agent's output stream to
     * external observability systems. Errors thrown by the callback are
     * swallowed.
     */
    readonly onAgentStreamEvent?: (event: AgentStreamEvent) => void;
    /**
     * When `true`, every raw stdout line the agent emits is appended
     * verbatim to the same log file at `path`, in real time. Includes
     * lines the provider's stream parser would otherwise drop (e.g.
     * tool-use blocks for unrecognised tools). Intended for debugging
     * stuck or unexpected agent behavior — note that the raw JSON is
     * interleaved with the human-readable log output. Default: `false`.
     */
    readonly verbose?: boolean;
}
/** Render progress and agent output as an interactive UI in the terminal (terminal mode). */
 | {
    readonly type: "stdout";
    /**
     * When `true`, every raw stdout line the agent emits is written
     * verbatim to `process.stdout`, in real time. Includes lines the
     * provider's stream parser would otherwise drop. Intended for
     * debugging stuck or unexpected agent behavior. Note: the raw output
     * is interleaved with the interactive terminal UI. Default: `false`.
     */
    readonly verbose?: boolean;
};
/** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
interface Timeouts {
    /** Timeout (ms) for the host-side copy of `copyToWorktree` paths into the worktree. Default: 60_000. */
    readonly copyToWorktreeMs?: number;
    /** Timeout (ms) for each in-sandbox git setup command (safe.directory, user.name/email, branch discovery). Default: 10_000. */
    readonly gitSetupMs?: number;
    /** Timeout (ms) for collecting the commits produced during the run. Default: 30_000. */
    readonly commitCollectionMs?: number;
    /** Timeout (ms) for merging the temp branch back to the host branch (merge-to-head strategy). Default: 30_000. */
    readonly mergeToHostMs?: number;
}
interface RunOptions<A extends AgentProvider = AgentProvider> {
    /** Agent provider to use (e.g. claudeCode("claude-opus-4-8")) */
    readonly agent: A;
    /** Sandbox provider (e.g. docker({ imageName: "sandcastle:myrepo" })). */
    readonly sandbox: SandboxProvider;
    /**
     * Host repo directory. Replaces `process.cwd()` as the anchor for
     * `.sandcastle/worktrees/`, `.sandcastle/.env`, `.sandcastle/logs/`,
     * `.sandcastle/patches/`, and git operations.
     *
     * - Relative paths are resolved against `process.cwd()`.
     * - Absolute paths are used as-is.
     * - Defaults to `process.cwd()` when omitted.
     */
    readonly cwd?: string;
    /** Inline prompt string (mutually exclusive with promptFile) */
    readonly prompt?: string;
    /**
     * Path to a prompt file (mutually exclusive with prompt).
     *
     * **Note:** `promptFile` is always resolved against `process.cwd()`, not
     * against the `cwd` option. If you set a custom `cwd`, pass an absolute
     * `promptFile` to avoid ambiguity.
     */
    readonly promptFile?: string;
    /** Maximum iterations to run (default: 1) */
    readonly maxIterations?: number;
    /** Lifecycle hooks grouped by execution location (host or sandbox). */
    readonly hooks?: SandboxHooks;
    /** Key-value map for {{KEY}} placeholder substitution in prompts */
    readonly promptArgs?: PromptArgs;
    /** Logging mode (default: { type: 'file' } with auto-generated path under .sandcastle/logs/) */
    readonly logging?: LoggingOption;
    /** Substring(s) the agent emits to stop the iteration loop early. Matched via `includes` against agent output. (default: `"<promise>COMPLETE</promise>"`) */
    readonly completionSignal?: string | string[];
    /** Idle timeout in seconds. If the agent produces no output for this long, it fails. Default: 600 (10 minutes) */
    readonly idleTimeoutSeconds?: number;
    /**
     * Grace window in seconds after a completion signal is observed in the
     * agent's output. The agent process is expected to exit shortly after
     * emitting the signal; if it does not (typically because a spawned child —
     * a `gh`/git subprocess or long-lived MCP server — keeps stdout open),
     * Sandcastle force-completes the iteration with a warning. Resets on every
     * subsequent output line so trailing data (token-usage events, terminal
     * `result` events, structured-output tags) is still captured. Independent
     * of `idleTimeoutSeconds`. Default: 60.
     */
    readonly completionTimeoutSeconds?: number;
    /** Optional name for the run, shown as a prefix in log output */
    readonly name?: string;
    /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
    readonly copyToWorktree?: string[];
    /** Branch strategy — controls how the agent's changes relate to branches.
     * Defaults to { type: "head" } for bind-mount providers and { type: "merge-to-head" } for isolated providers. */
    readonly branchStrategy?: BranchStrategy;
    /** Resume a prior Claude Code session by ID. The session JSONL must exist on the host. Incompatible with maxIterations > 1. */
    readonly resumeSession?: string;
    /**
     * An `AbortSignal` that cancels the run when aborted.
     *
     * - If `signal.aborted` is already `true` at entry, `run()` rejects
     *   immediately without doing any setup work.
     * - Aborting mid-iteration kills the in-flight agent subprocess.
     * - Phase boundaries (between iterations) also check the signal.
     * - The rejected promise surfaces `signal.reason` via
     *   `signal.throwIfAborted()` — no Sandcastle-specific wrapping.
     * - The worktree is preserved on disk after abort (error-path behavior).
     */
    readonly signal?: AbortSignal;
    /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
    readonly timeouts?: Timeouts;
    /**
     * Structured output definition. When provided, the agent's stdout is
     * scanned for the configured XML tag after the iteration completes, and the
     * result is parsed/validated and returned on `RunResult.output`.
     *
     * Use `Output.object({ tag, schema })` for JSON+schema or
     * `Output.string({ tag })` for raw string extraction.
     *
     * Constraints:
     * - `maxIterations` must be `1` (the default).
     * - The resolved prompt must contain the configured opening tag literal.
     *
     * See ADR 0010 for design rationale.
     */
    readonly output?: OutputDefinition;
}

type ResumeRunResultOptions = Omit<RunOptions, "agent" | "sandbox" | "prompt" | "promptFile" | "resumeSession" | "forkSession" | "maxIterations">;
interface RunResult {
    /** Per-iteration results (use `iterations.length` for the count). */
    readonly iterations: IterationResult[];
    /** The matched completion signal string, or undefined if no signal fired before the iteration limit. */
    readonly completionSignal?: string;
    /** Combined stdout output from all agent iterations. */
    readonly stdout: string;
    /** List of commits made by the agent during the run, each identified by its SHA. */
    readonly commits: {
        sha: string;
    }[];
    /** The branch name the agent worked on inside the sandbox. */
    readonly branch: string;
    /** Path to the log file, if logging was drained to a file. */
    readonly logFilePath?: string;
    /** Host path to the preserved worktree, set when the run succeeded but the worktree had uncommitted changes. */
    readonly preservedWorktreePath?: string;
    /** Continue the last captured agent session for exactly one iteration.
     *  Present only when the provider supports resume (`sessionStorage` populated). */
    readonly resume?: (prompt: string, options?: ResumeRunResultOptions) => Promise<RunResult>;
    /**
     * Fork the last captured agent session for exactly one iteration: the
     * parent session JSONL is left intact and the child run gets its own
     * session id, enabling fan-out patterns where multiple children diverge
     * from a single parent. Present only when the provider supports resume
     * (`sessionStorage` populated).
     *
     * Sessions only: fork isolates the agent session, not the branch or
     * sandbox. Safe concurrent fan-out (`Promise.all([r.fork(a), r.fork(b)])`)
     * requires the caller to give each fork a distinct `branch` — `head` and
     * `merge-to-head` are not safe for concurrent forks. See ADR 0018.
     */
    readonly fork?: (prompt: string, options?: ResumeRunResultOptions) => Promise<RunResult>;
}
/** Overload: with `Output.object`, returns `RunResult` with typed `output: T`. */
declare function run<T, A extends AgentProvider>(options: RunOptions<A> & {
    output: OutputObjectDefinition<T>;
}): Promise<RunResult & {
    output: T;
}>;
/** Overload: with `Output.string`, returns `RunResult` with `output: string`. */
declare function run<A extends AgentProvider>(options: RunOptions<A> & {
    output: OutputStringDefinition;
}): Promise<RunResult & {
    output: string;
}>;
/** Overload: without `output`, returns the standard `RunResult`. */
declare function run<A extends AgentProvider>(options: RunOptions<A>): Promise<RunResult>;

interface InteractiveOptions {
    /** Agent provider to use (e.g. claudeCode("claude-opus-4-8")) */
    readonly agent: AgentProvider;
    /** Sandbox provider (e.g. docker(), noSandbox()). */
    readonly sandbox?: AnySandboxProvider;
    /** Inline prompt string (mutually exclusive with promptFile). */
    readonly prompt?: string;
    /** Path to a prompt file (mutually exclusive with prompt). */
    readonly promptFile?: string;
    /** Optional name for the interactive session. */
    readonly name?: string;
    /** Branch strategy — controls how the agent's changes relate to branches.
     * Defaults to { type: "head" } for bind-mount providers and { type: "merge-to-head" } for isolated providers. */
    readonly branchStrategy?: BranchStrategy;
    /** Hooks to run during sandbox lifecycle */
    readonly hooks?: SandboxHooks;
    /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
    readonly copyToWorktree?: string[];
    /** Key-value map for {{KEY}} placeholder substitution in prompts */
    readonly promptArgs?: PromptArgs;
    /** Environment variables to inject into the sandbox. */
    readonly env?: Record<string, string>;
    /**
     * Host repo directory to use instead of `process.cwd()`.
     *
     * Relative paths resolve against `process.cwd()`; absolute paths pass
     * through as-is. A {@link CwdError} is thrown if the path does not exist
     * or is not a directory.
     */
    readonly cwd?: string;
    /**
     * An `AbortSignal` that cancels the interactive session when aborted.
     *
     * - If `signal.aborted` is already `true` at entry, `interactive()` rejects
     *   immediately without doing any setup work.
     * - Aborting during an active session kills the agent subprocess.
     * - The rejected promise surfaces `signal.reason` via
     *   `signal.throwIfAborted()` — no Sandcastle-specific wrapping.
     * - The worktree is preserved on disk after abort (error-path behavior).
     */
    readonly signal?: AbortSignal;
    /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
    readonly timeouts?: Timeouts;
}
interface InteractiveResult {
    /** List of commits made during the interactive session. */
    readonly commits: {
        sha: string;
    }[];
    /** The branch name the agent worked on. */
    readonly branch: string;
    /** Host path to the preserved worktree, if worktree had uncommitted changes. */
    readonly preservedWorktreePath?: string;
    /** Exit code of the interactive process. */
    readonly exitCode: number;
}
/**
 * Launch an interactive agent session inside a sandbox.
 *
 * The user sees the agent's TUI directly. When the session ends,
 * Sandcastle collects commits and handles branch merging, just like run().
 *
 * Full prompt preprocessing pipeline: PromptResolver -> PromptArgumentSubstitution
 * -> PromptPreprocessor (shell expressions inside sandbox).
 *
 * All three branch strategies are supported: head, merge-to-head, branch.
 */
declare const interactive: (options: InteractiveOptions) => Promise<InteractiveResult>;

interface CreateSandboxOptions {
    /** Explicit branch for the worktree (required). */
    readonly branch: string;
    /**
     * Ref to fork from when `branch` does not yet exist. Ignored when the branch
     * already exists. Defaults to `HEAD`.
     */
    readonly baseBranch?: string;
    /** Sandbox provider (e.g. docker({ imageName: "sandcastle:myrepo" })). */
    readonly sandbox: SandboxProvider;
    /**
     * Host repo directory. Replaces `process.cwd()` as the anchor for
     * `.sandcastle/worktrees/`, `.sandcastle/.env`, and git operations.
     *
     * - Relative paths are resolved against `process.cwd()`.
     * - Absolute paths are used as-is.
     * - Defaults to `process.cwd()` when omitted.
     */
    readonly cwd?: string;
    /** Lifecycle hooks grouped by execution location (host or sandbox). */
    readonly hooks?: SandboxHooks;
    /** Paths relative to the host repo root to copy into the worktree at creation time. */
    readonly copyToWorktree?: string[];
    /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
    readonly timeouts?: Timeouts;
}
/**
 * Options accepted by `SandboxRunResult.resume()` / `.fork()`. Mirrors
 * `ResumeRunResultOptions` in `run.ts` — drops the fields owned by the
 * captured run (prompt, iteration count, resumeSession/forkSession bookkeeping).
 *
 * Defined as the base interface that `SandboxRunOptions` extends — the
 * interface-extends shape is cheaper for the TS checker than
 * `Omit<SandboxRunOptions, ...>` (which forces a mapped-type computation
 * on every reference).
 */
interface ResumeSandboxRunResultOptions {
    /** Key-value map for {{KEY}} placeholder substitution in prompts. */
    readonly promptArgs?: PromptArgs;
    /** Substring(s) the agent emits to stop the iteration loop early. */
    readonly completionSignal?: string | string[];
    /** Idle timeout in seconds. Default: 600. */
    readonly idleTimeoutSeconds?: number;
    /** Grace window in seconds after a completion signal is observed but the agent process has not exited. See ADR 0019. Default: 60. */
    readonly completionTimeoutSeconds?: number;
    /** Display name for this run. */
    readonly name?: string;
    /** Logging mode. */
    readonly logging?: LoggingOption;
    /**
     * An `AbortSignal` that cancels the run when aborted.
     *
     * - Pre-aborted signal rejects immediately without setup.
     * - Mid-iteration abort kills the in-flight agent subprocess.
     * - The rejected promise surfaces `signal.reason` verbatim.
     * - The `Sandbox` handle remains usable after abort — call `.run()` again
     *   with a fresh signal, or `.close()` to tear down.
     */
    readonly signal?: AbortSignal;
}
interface SandboxRunOptions extends ResumeSandboxRunResultOptions {
    /** Agent provider to use (e.g. claudeCode("claude-opus-4-8")). */
    readonly agent: AgentProvider;
    /** Inline prompt string (mutually exclusive with promptFile). */
    readonly prompt?: string;
    /** Path to a prompt file (mutually exclusive with prompt). */
    readonly promptFile?: string;
    /** Maximum iterations to run (default: 1). */
    readonly maxIterations?: number;
    /** Resume a prior agent session by id. The session JSONL must exist on the host (captured by a prior `sandbox.run()`). Incompatible with `maxIterations > 1`. */
    readonly resumeSession?: string;
}
interface SandboxRunResult {
    /** Per-iteration results (use `iterations.length` for the count). */
    readonly iterations: IterationResult[];
    /** The matched completion signal string, or undefined if none fired. */
    readonly completionSignal?: string;
    /** Combined stdout output from all agent iterations. */
    readonly stdout: string;
    /** List of commits made by the agent during the run. */
    readonly commits: {
        sha: string;
    }[];
    /** Path to the log file, if logging was drained to a file. */
    readonly logFilePath?: string;
    /**
     * Continue the last captured agent session for exactly one iteration inside
     * the same long-lived sandbox. Present only when the provider supports
     * resume (`sessionStorage` populated) and a session id was captured.
     */
    readonly resume?: (prompt: string, options?: ResumeSandboxRunResultOptions) => Promise<SandboxRunResult>;
    /**
     * Fork the last captured agent session for exactly one iteration inside the
     * same long-lived sandbox: the parent session JSONL is left intact and the
     * child run gets its own session id. Present only when the provider
     * supports resume (`sessionStorage` populated) and a session id was
     * captured. See ADR 0018 for fork semantics.
     */
    readonly fork?: (prompt: string, options?: ResumeSandboxRunResultOptions) => Promise<SandboxRunResult>;
}
interface SandboxInteractiveOptions {
    /** Agent provider to use (e.g. claudeCode("claude-opus-4-8")). */
    readonly agent: AgentProvider;
    /** Inline prompt string (mutually exclusive with promptFile). */
    readonly prompt?: string;
    /** Path to a prompt file (mutually exclusive with prompt). */
    readonly promptFile?: string;
    /** Key-value map for {{KEY}} placeholder substitution in prompts. */
    readonly promptArgs?: PromptArgs;
    /** Display name for this interactive session. */
    readonly name?: string;
    /**
     * An `AbortSignal` that cancels the interactive session when aborted.
     *
     * - Pre-aborted signal rejects immediately without setup.
     * - The rejected promise surfaces `signal.reason` verbatim.
     * - The `Sandbox` handle remains usable after abort.
     */
    readonly signal?: AbortSignal;
}
interface SandboxInteractiveResult {
    /** List of commits made during the interactive session. */
    readonly commits: {
        sha: string;
    }[];
    /** Exit code of the interactive process. */
    readonly exitCode: number;
}
interface CloseResult {
    /** Host path to the preserved worktree, set when the worktree had uncommitted changes. */
    readonly preservedWorktreePath?: string;
}
interface Sandbox {
    /** The branch the worktree is on. */
    readonly branch: string;
    /** Host path to the worktree. */
    readonly worktreePath: string;
    /** Invoke an agent inside the existing sandbox. */
    run(options: SandboxRunOptions): Promise<SandboxRunResult>;
    /** Launch an interactive agent session inside the existing sandbox. */
    interactive(options: SandboxInteractiveOptions): Promise<SandboxInteractiveResult>;
    /**
     * Execute a command inside the existing sandbox.
     *
     * `cwd` defaults to the sandbox repo path (same default `interactive()`
     * uses), so callers get the same working directory across providers. Pass
     * `cwd` to override.
     *
     * Returns the full `ExecResult` — non-zero `exitCode` is surfaced, not
     * thrown. Callers that want strict semantics should check `result.exitCode`
     * themselves (matching the contract of `BindMountSandboxHandle.exec`).
     */
    exec(command: string, options?: SandboxExecOptions): Promise<ExecResult>;
    /** Tear down the sandbox and worktree. */
    close(): Promise<CloseResult>;
    /** Auto teardown via `await using`. */
    [Symbol.asyncDispose](): Promise<void>;
}
/** Options accepted by `Sandbox.exec()`. Mirrors the provider handle's `exec` options. */
interface SandboxExecOptions {
    /** Per-line stdout callback for streaming output. */
    readonly onLine?: (line: string) => void;
    /** Working directory for the command. Defaults to the sandbox repo path. */
    readonly cwd?: string;
    /** Run the command with sudo, when the provider supports it. */
    readonly sudo?: boolean;
    /** Stdin payload — piped to the child process and then closed. Avoids the Linux 128 KB per-arg limit. */
    readonly stdin?: string;
}
/**
 * Eagerly creates a git worktree on the provided explicit branch and starts
 * a sandbox with the worktree bind-mounted. Returns a Sandbox handle that
 * can be reused across multiple `run()` calls.
 */
declare const createSandbox: (options: CreateSandboxOptions) => Promise<Sandbox>;

/** Branch strategies valid for createWorktree — head is excluded. */
type WorktreeBranchStrategy = MergeToHeadBranchStrategy | NamedBranchStrategy;
interface CreateWorktreeOptions {
    /** Branch strategy — only 'branch' and 'merge-to-head' are allowed. */
    readonly branchStrategy: WorktreeBranchStrategy;
    /**
     * Host repo directory. Replaces `process.cwd()` as the anchor for
     * `.sandcastle/worktrees/`, `.sandcastle/.env`, and git operations.
     *
     * - Relative paths are resolved against `process.cwd()`.
     * - Absolute paths are used as-is.
     * - Defaults to `process.cwd()` when omitted.
     */
    readonly cwd?: string;
    /** Paths relative to the host repo root to copy into the worktree at creation time. */
    readonly copyToWorktree?: string[];
    /** Lifecycle hooks grouped by execution location (host or sandbox).
     *  Only `host.onWorktreeReady` is executed here — other hooks are passed through
     *  to `run()`, `interactive()`, or `createSandbox()`. */
    readonly hooks?: SandboxHooks;
    /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
    readonly timeouts?: Timeouts;
}
interface WorktreeInteractiveOptions {
    /** Agent provider to use (e.g. claudeCode("claude-opus-4-8")) */
    readonly agent: AgentProvider;
    /** Sandbox provider (e.g. docker(), noSandbox()). Defaults to noSandbox(). */
    readonly sandbox?: AnySandboxProvider;
    /** Inline prompt string (mutually exclusive with promptFile). */
    readonly prompt?: string;
    /** Path to a prompt file (mutually exclusive with prompt). */
    readonly promptFile?: string;
    /** Optional name for the interactive session. */
    readonly name?: string;
    /** Hooks to run during sandbox lifecycle */
    readonly hooks?: SandboxHooks;
    /** Key-value map for {{KEY}} placeholder substitution in prompts */
    readonly promptArgs?: PromptArgs;
    /** Environment variables to inject into the sandbox. */
    readonly env?: Record<string, string>;
    /**
     * An `AbortSignal` that cancels the interactive session when aborted.
     *
     * - If `signal.aborted` is already `true` at entry, rejects immediately.
     * - Aborting during an active session kills the agent subprocess.
     * - The worktree is preserved on disk after abort.
     * - The `Worktree` handle remains usable for subsequent operations.
     * - The rejected promise surfaces `signal.reason` via
     *   `signal.throwIfAborted()` — no Sandcastle-specific wrapping.
     */
    readonly signal?: AbortSignal;
}
interface WorktreeRunOptions {
    /** Agent provider to use (e.g. claudeCode("claude-opus-4-8")) */
    readonly agent: AgentProvider;
    /** Sandbox provider (e.g. docker()). Required — AFK agents should always be sandboxed. */
    readonly sandbox: SandboxProvider;
    /** Inline prompt string (mutually exclusive with promptFile). */
    readonly prompt?: string;
    /** Path to a prompt file (mutually exclusive with prompt). */
    readonly promptFile?: string;
    /** Key-value map for {{KEY}} placeholder substitution in prompts */
    readonly promptArgs?: PromptArgs;
    /** Maximum iterations to run (default: 1). */
    readonly maxIterations?: number;
    /** Substring(s) the agent emits to stop the iteration loop early. */
    readonly completionSignal?: string | string[];
    /** Idle timeout in seconds. Default: 600. */
    readonly idleTimeoutSeconds?: number;
    /** Grace window in seconds after a completion signal is observed but the agent process has not exited. See ADR 0019. Default: 60. */
    readonly completionTimeoutSeconds?: number;
    /** Optional name for the run. */
    readonly name?: string;
    /** Logging mode. */
    readonly logging?: LoggingOption;
    /** Hooks to run during sandbox lifecycle */
    readonly hooks?: SandboxHooks;
    /** Environment variables to inject into the sandbox. */
    readonly env?: Record<string, string>;
    /** Resume a prior Claude Code session by ID. The session JSONL must exist on the host. Incompatible with maxIterations > 1. */
    readonly resumeSession?: string;
    /**
     * An `AbortSignal` that cancels the run when aborted.
     *
     * - If `signal.aborted` is already `true` at entry, rejects immediately
     *   without doing any setup work.
     * - Aborting mid-iteration kills the in-flight agent subprocess.
     * - The worktree is preserved on disk after abort.
     * - The `Worktree` handle remains usable for subsequent operations.
     */
    readonly signal?: AbortSignal;
}
interface WorktreeRunResult {
    /** Per-iteration results (use `iterations.length` for the count). */
    readonly iterations: IterationResult[];
    /** The matched completion signal string, or undefined if none fired. */
    readonly completionSignal?: string;
    /** Combined stdout output from all agent iterations. */
    readonly stdout: string;
    /** List of commits made by the agent during the run. */
    readonly commits: {
        sha: string;
    }[];
    /** The branch name the agent worked on. */
    readonly branch: string;
    /** Path to the log file, if logging was drained to a file. */
    readonly logFilePath?: string;
}
interface WorktreeCreateSandboxOptions {
    /** Sandbox provider (e.g. docker({ imageName: "sandcastle:myrepo" })). */
    readonly sandbox: SandboxProvider;
    /** Lifecycle hooks grouped by execution location (host or sandbox). */
    readonly hooks?: SandboxHooks;
    /** Paths relative to the host repo root to copy into the worktree at creation time. */
    readonly copyToWorktree?: string[];
    /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
    readonly timeouts?: Timeouts;
}
interface Worktree {
    /** The branch the worktree is on. */
    readonly branch: string;
    /** Host path to the worktree (worktree). */
    readonly worktreePath: string;
    /** Run an AFK agent in this worktree with a required sandbox. */
    run(options: WorktreeRunOptions): Promise<WorktreeRunResult>;
    /** Run an interactive agent session in this worktree. */
    interactive(options: WorktreeInteractiveOptions): Promise<InteractiveResult>;
    /** Create a long-lived sandbox backed by this worktree's worktree. */
    createSandbox(options: WorktreeCreateSandboxOptions): Promise<Sandbox>;
    /** Clean up the worktree. Preserves worktree if dirty. */
    close(): Promise<CloseResult>;
    /** Auto cleanup via `await using`. */
    [Symbol.asyncDispose](): Promise<void>;
}
/**
 * Creates a git worktree as an independent, first-class worktree.
 * Returns a Worktree handle with close() and [Symbol.asyncDispose]().
 *
 * Only accepts 'branch' and 'merge-to-head' strategies — 'head' is a
 * compile-time type error since head means no worktree.
 */
declare const createWorktree: (options: CreateWorktreeOptions) => Promise<Worktree>;

interface CwdErrorConstructor {
    new (args: {
        readonly message: string;
        readonly cwd: string;
    }): CwdError;
    readonly prototype: CwdError;
}
/**
 * The provided `cwd` path does not exist or is not a directory.
 *
 * Public-facing type for `CwdError`. The runtime class is the same
 * `Data.TaggedError` from `resolveCwd.ts`, but we re-declare its public
 * shape here as a plain `Error` subclass so that Effect's type machinery
 * does not leak into Sandcastle's published `.d.ts` files.
 */
interface CwdError extends Error {
    readonly _tag: "CwdError";
    readonly message: string;
    readonly cwd: string;
}
/** The provided `cwd` path does not exist or is not a directory. */
declare const CwdError: CwdErrorConstructor;

export { type AgentCommandOptions, type AgentProvider, type AgentStreamEvent, AnySandboxProvider, BindMountSandboxHandle, BranchStrategy, type ClaudeCodeOptions, type CloseResult, type CodexOptions, type CopilotOptions, type CreateSandboxOptions, type CreateWorktreeOptions, type CursorOptions, CwdError, ExecResult, type HostSessionLookup, type InteractiveOptions, type InteractiveResult, type IterationResult, type IterationUsage, type LoggingOption, MergeToHeadBranchStrategy, NamedBranchStrategy, type OpenCodeOptions, Output, type OutputDefinition, type OutputObjectDefinition, type OutputStringDefinition, type PiOptions, type PrintCommand, type PromptArgs, type ResumeSandboxRunResultOptions, type RunOptions, type RunResult, type Sandbox, type SandboxExecOptions, type SandboxHooks, type SandboxInteractiveOptions, type SandboxInteractiveResult, SandboxProvider, type SandboxRunOptions, type SandboxRunResult, StructuredOutputError, type Timeouts, type Worktree, type WorktreeBranchStrategy, type WorktreeCreateSandboxOptions, type WorktreeInteractiveOptions, type WorktreeRunOptions, type WorktreeRunResult, claudeCode, claudeHostSessionPath, claudeSandboxSessionPath, codex, copilot, createSandbox, createWorktree, cursor, encodeProjectPath, findClaudeSessionOnHost, findCodexSessionOnHost, interactive, opencode, pi, run, transferClaudeSession, transferCodexSession };
