import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { existsSync } from "node:fs";
import path, { join } from "node:path";
import { styleText } from "node:util";
import { Effect, Layer } from "effect";
import { resolveCwd } from "./resolveCwd.js";
import type { AgentProvider } from "./AgentProvider.js";
import {
  ClackDisplay,
  Display,
  FileDisplay,
  type Severity,
} from "./Display.js";
import {
  orchestrate,
  type IterationResult,
  type IterationUsage,
  type OrchestrateResult,
} from "./Orchestrator.js";
import { resolvePrompt } from "./PromptResolver.js";
import {
  WorktreeDockerSandboxFactory,
  SandboxConfig,
} from "./SandboxFactory.js";
import type { SandboxProvider, BranchStrategy } from "./SandboxProvider.js";
import { resolveEnv } from "./EnvResolver.js";
import { formatErrorMessage } from "./ErrorHandler.js";
import type { SandboxError } from "./errors.js";
import {
  callbackAgentStreamEmitterLayer,
  noopAgentStreamEmitterLayer,
  type AgentStreamEvent,
} from "./AgentStreamEmitter.js";
import type { SandboxHooks } from "./SandboxLifecycle.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { hostSessionStore } from "./SessionStore.js";
import { defaultSessionPathsLayer } from "./SessionPaths.js";
import { generateTempBranchName, getCurrentBranch } from "./WorktreeManager.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import type {
  OutputDefinition,
  OutputObjectDefinition,
  OutputStringDefinition,
} from "./Output.js";
import { extractStructuredOutput } from "./extractStructuredOutput.js";

/** Default maximum number of iterations for a run. */
export const DEFAULT_MAX_ITERATIONS = 1;

/** Replace characters that are invalid or problematic in file paths with dashes. */
export const sanitizeBranchForFilename = (branch: string): string =>
  branch.replace(/[/\\:*?"<>|]/g, "-");

export interface FileDisplayStartupOptions {
  readonly logPath: string;
  readonly agentName?: string;
  readonly branch?: string;
  /** Resolved host repo directory. When it differs from `process.cwd()`, the
   *  log-file hint is printed as an absolute path so it can be pasted into any
   *  terminal. When it equals `process.cwd()` (or is omitted), a relative path
   *  is printed instead. */
  readonly hostRepoDir?: string;
}

/**
 * Print the startup message to the terminal when using file-based logging.
 * Uses styleText for lightweight bold/dim styling — does not use Clack.
 */
export const printFileDisplayStartup = (
  options: FileDisplayStartupOptions,
): void => {
  const name = options.agentName ?? "Agent";
  const label = styleText("bold", `[${name}]`);
  const branchPart = options.branch ? ` on branch ${options.branch}` : "";
  const hostRepoDir = options.hostRepoDir ?? process.cwd();
  const displayLogPath =
    hostRepoDir === process.cwd()
      ? path.relative(process.cwd(), options.logPath)
      : options.logPath;
  console.log(`${label} Started${branchPart}`);
  console.log(styleText("dim", `  tail -f ${displayLogPath}`));
};

/**
 * Build the log filename for a run.
 * When a targetBranch is provided (temp branch mode), prefixes the filename
 * with the sanitized target branch name so developers can identify which
 * branch the run was targeting: `<targetBranch>-<resolvedBranch>.log`
 * When no targetBranch, uses just the resolved branch: `<resolvedBranch>.log`
 * When a name is provided, appends it to avoid collisions in multi-agent workflows.
 */
export const buildLogFilename = (
  resolvedBranch: string,
  targetBranch?: string,
  name?: string,
): string => {
  const sanitized = sanitizeBranchForFilename(resolvedBranch);
  const nameSuffix = name
    ? `-${name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`
    : "";
  if (targetBranch) {
    return `${sanitizeBranchForFilename(targetBranch)}-${sanitized}${nameSuffix}.log`;
  }
  return `${sanitized}${nameSuffix}.log`;
};

export interface RunSummaryRowsOptions {
  readonly name?: string;
  readonly agentName: string;
  readonly sandboxName: string;
  readonly maxIterations: number;
  readonly branch: string;
}

/**
 * Build the summary rows for a run, used in both terminal mode and
 * log-to-file mode. When a custom name is provided it appears as the
 * Agent value instead of the internal provider name.
 */
export const buildRunSummaryRows = (
  options: RunSummaryRowsOptions,
): Record<string, string> => ({
  Agent: options.name ?? options.agentName,
  Sandbox: options.sandboxName,
  "Max iterations": String(options.maxIterations),
  Branch: options.branch,
});

/**
 * Build the completion status message for a run, used in both terminal mode
 * and log-to-file mode to record the final outcome.
 */
export const buildCompletionMessage = (
  completionSignal: string | undefined,
  iterationsRun: number,
): { readonly message: string; readonly severity: Severity } => {
  if (completionSignal !== undefined) {
    return {
      message: `Run complete: agent finished after ${iterationsRun} iteration(s).`,
      severity: "success",
    };
  }
  return {
    message: `Run complete: reached ${iterationsRun} iteration(s) without completion signal.`,
    severity: "warn",
  };
};

/**
 * Format the context window size from an iteration's usage data.
 * Returns a string like "103k" representing the total input-side tokens
 * (inputTokens + cacheCreationInputTokens + cacheReadInputTokens)
 * rounded up to the nearest 1000.
 */
export const formatContextWindowSize = (usage: IterationUsage): string => {
  const total =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  return `${Math.ceil(total / 1000)}k`;
};

/**
 * Build "Context window: NNNk" lines for iterations that have usage data.
 * Returns an empty array when no iterations carry usage.
 */
export const buildContextWindowLines = (
  iterations: readonly Pick<IterationResult, "usage">[],
): string[] =>
  iterations
    .filter((it): it is { usage: IterationUsage } => it.usage !== undefined)
    .map((it) => `Context window: ${formatContextWindowSize(it.usage)}`);

/**
 * Controls where Sandcastle writes iteration progress and agent output.
 * Use `"file"` (log-to-file mode) to write to a log file on disk, or
 * `"stdout"` (terminal mode) to render an interactive UI in the terminal.
 */
export type LoggingOption =
  /** Write progress and agent output to a log file at the given path (log-to-file mode). */
  | {
      readonly type: "file";
      readonly path: string;
      /**
       * Optional callback invoked for each agent stream event (text chunk or
       * tool call) in addition to being written to the log file. Intended for
       * forwarding the agent's output stream to external observability
       * systems. Errors thrown by the callback are swallowed.
       */
      readonly onAgentStreamEvent?: (event: AgentStreamEvent) => void;
    }
  /** Render progress and agent output as an interactive UI in the terminal (terminal mode). */
  | { readonly type: "stdout" };

/** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
export interface Timeouts {
  /** Timeout (ms) for the host-side copy of `copyToWorktree` paths into the worktree. Default: 60_000. */
  readonly copyToWorktreeMs?: number;
}

export interface RunOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-7")) */
  readonly agent: AgentProvider;
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

export type { IterationResult, IterationUsage } from "./Orchestrator.js";

export interface RunResult {
  /** Per-iteration results (use `iterations.length` for the count). */
  readonly iterations: IterationResult[];
  /** The matched completion signal string, or undefined if no signal fired before the iteration limit. */
  readonly completionSignal?: string;
  /** Combined stdout output from all agent iterations. */
  readonly stdout: string;
  /** List of commits made by the agent during the run, each identified by its SHA. */
  readonly commits: { sha: string }[];
  /** The branch name the agent worked on inside the sandbox. */
  readonly branch: string;
  /** Path to the log file, if logging was drained to a file. */
  readonly logFilePath?: string;
  /** Host path to the preserved worktree, set when the run succeeded but the worktree had uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

/** Overload: with `Output.object`, returns `RunResult` with typed `output: T`. */
export function run<T>(
  options: RunOptions & { output: OutputObjectDefinition<T> },
): Promise<RunResult & { output: T }>;
/** Overload: with `Output.string`, returns `RunResult` with `output: string`. */
export function run(
  options: RunOptions & { output: OutputStringDefinition },
): Promise<RunResult & { output: string }>;
/** Overload: without `output`, returns the standard `RunResult`. */
export function run(options: RunOptions): Promise<RunResult>;
export async function run(options: RunOptions): Promise<RunResult & { output?: unknown }> {
  // If signal is already aborted, reject immediately without any setup
  options.signal?.throwIfAborted();

  const {
    prompt,
    promptFile,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    hooks,
    agent: provider,
  } = options;

  // Derive branch strategy: explicit option > default based on provider tag
  const branchStrategy: BranchStrategy =
    options.branchStrategy ??
    (options.sandbox.tag === "isolated"
      ? { type: "merge-to-head" }
      : { type: "head" });
  const effectiveBranchType = branchStrategy.type;

  // Validate: head strategy is not supported with isolated providers
  if (effectiveBranchType === "head" && options.sandbox.tag === "isolated") {
    throw new Error(
      "head branch strategy is not supported with isolated providers",
    );
  }

  // Validate: copyToWorktree is incompatible with head strategy
  if (
    effectiveBranchType === "head" &&
    options.copyToWorktree &&
    options.copyToWorktree.length > 0
  ) {
    throw new Error(
      "copyToWorktree is not supported with head branch strategy. " +
        "In head mode the host working directory is bind-mounted directly.",
    );
  }

  // Validate: resumeSession + maxIterations > 1 is not allowed
  if (options.resumeSession && maxIterations > 1) {
    throw new Error(
      "resumeSession cannot be combined with maxIterations > 1. " +
        "Resume applies to iteration 1 only; multi-iteration resume semantics are not supported.",
    );
  }

  // Validate: output requires maxIterations === 1
  if (options.output && maxIterations !== 1) {
    throw new Error(
      "output requires maxIterations to be 1. " +
        "Structured output is only supported for single-iteration runs.",
    );
  }

  // Extract explicit branch when in branch mode
  const branch: string | undefined =
    branchStrategy.type === "branch" ? branchStrategy.branch : undefined;

  const hostRepoDir = await Effect.runPromise(
    resolveCwd(options.cwd).pipe(Effect.provide(NodeContext.layer)),
  );

  // Validate: resumeSession file must exist on the host
  if (options.resumeSession) {
    const hStore = hostSessionStore(hostRepoDir);
    const sessionPath = hStore.sessionFilePath(options.resumeSession);
    if (!existsSync(sessionPath)) {
      throw new Error(
        `resumeSession "${options.resumeSession}" not found: expected session file at ${sessionPath}`,
      );
    }
  }

  // Resolve prompt
  const resolved = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile }).pipe(
      Effect.provide(NodeContext.layer),
    ),
  );
  const rawPrompt = resolved.text;
  const isInlinePrompt = resolved.source === "inline";

  // Validate: output tag must appear in the resolved prompt
  if (options.output) {
    const openTag = `<${options.output.tag}>`;
    if (!rawPrompt.includes(openTag)) {
      throw new Error(
        `output tag <${options.output.tag}> not found in the resolved prompt. ` +
          "The caller must instruct the agent to emit the configured tag.",
      );
    }
  }

  const agentName = provider.name;

  // Resolve env vars and merge with provider env
  const resolvedEnv = await Effect.runPromise(
    resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
  );
  const env = mergeProviderEnv({
    resolvedEnv,
    agentProviderEnv: provider.env,
    sandboxProviderEnv: options.sandbox.env,
  });

  // Always capture the host's current branch for the TARGET_BRANCH built-in
  // prompt argument. When using a temp branch, it also prefixes the log filename.
  const currentHostBranch = await Effect.runPromise(
    getCurrentBranch(hostRepoDir),
  );

  // When in merge-to-head mode, generate a temporary branch name.
  // In head mode, use the host's current branch directly (no worktree).
  const resolvedBranch =
    effectiveBranchType === "head"
      ? currentHostBranch
      : (branch ?? generateTempBranchName(options.name));

  // When using a temp branch, prefix the log filename with the target branch
  // (the host's current branch) so developers can tell which branch was targeted.
  const targetBranch =
    effectiveBranchType === "merge-to-head" ? currentHostBranch : undefined;

  // Resolve logging option
  const resolvedLogging: LoggingOption = options.logging ?? {
    type: "file",
    path: join(
      hostRepoDir,
      ".sandcastle",
      "logs",
      buildLogFilename(resolvedBranch, targetBranch, options.name),
    ),
  };
  const displayLayer =
    resolvedLogging.type === "file"
      ? (() => {
          printFileDisplayStartup({
            logPath: resolvedLogging.path,
            agentName: options.name,
            branch: resolvedBranch,
            hostRepoDir,
          });
          return Layer.provide(
            FileDisplay.layer(resolvedLogging.path),
            NodeFileSystem.layer,
          );
        })()
      : ClackDisplay.layer;

  const factoryLayer = Layer.provide(
    WorktreeDockerSandboxFactory.layer,
    Layer.mergeAll(
      Layer.succeed(SandboxConfig, {
        env,
        hostRepoDir,
        copyToWorktree: options.copyToWorktree,
        name: options.name,
        sandboxProvider: options.sandbox,
        branchStrategy,
        hooks,
        signal: options.signal,
        timeouts: options.timeouts,
      }),
      NodeFileSystem.layer,
      displayLayer,
    ),
  );

  const agentStreamEmitterLayer =
    resolvedLogging.type === "file" && resolvedLogging.onAgentStreamEvent
      ? callbackAgentStreamEmitterLayer(resolvedLogging.onAgentStreamEvent)
      : noopAgentStreamEmitterLayer;

  const runLayer = Layer.mergeAll(
    factoryLayer,
    displayLayer,
    defaultSessionPathsLayer,
    agentStreamEmitterLayer,
  );

  const baseEffect = Effect.gen(function* () {
    const d = yield* Display;
    yield* d.intro(options.name ?? "sandcastle");
    const rows = buildRunSummaryRows({
      name: options.name,
      agentName,
      sandboxName: options.sandbox.name,
      maxIterations,
      branch: resolvedBranch,
    });
    yield* d.summary("Sandcastle Run", rows);

    const userArgs = options.promptArgs ?? {};

    // Inline prompts pass through to the agent literally — no substitution,
    // no built-in arg injection. Guard against silently ignoring promptArgs.
    let resolvedPrompt: string;
    if (isInlinePrompt) {
      yield* validateNoArgsWithInlinePrompt(userArgs);
      resolvedPrompt = rawPrompt;
    } else {
      yield* validateNoBuiltInArgOverride(userArgs);
      const effectiveArgs = {
        SOURCE_BRANCH: resolvedBranch,
        TARGET_BRANCH: currentHostBranch,
        ...userArgs,
      };
      const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
      resolvedPrompt = yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet,
      );
    }

    // In head mode, pass the host branch so SandboxLifecycle skips the merge step.
    // In merge-to-head mode, branch is undefined (triggers merge). In branch mode, it's the explicit branch.
    const orchestrateBranch =
      effectiveBranchType === "head" ? currentHostBranch : branch;

    const orchestrateResult = yield* orchestrate({
      hostRepoDir,
      iterations: maxIterations,
      hooks,
      prompt: resolvedPrompt,
      branch: orchestrateBranch,
      provider,
      completionSignal: options.completionSignal,
      idleTimeoutSeconds: options.idleTimeoutSeconds,
      name: options.name,
      resumeSession: options.resumeSession,
      signal: options.signal,
      skipPromptExpansion: isInlinePrompt,
    });

    const completion = buildCompletionMessage(
      orchestrateResult.completionSignal,
      orchestrateResult.iterations.length,
    );
    yield* d.status(completion.message, completion.severity);

    for (const line of buildContextWindowLines(orchestrateResult.iterations)) {
      yield* d.text(line);
    }

    return orchestrateResult;
  });

  // In file-logging mode, write errors to the log before they propagate.
  // In stdout mode (ClackDisplay), errors are already shown by withFriendlyErrors
  // in main.ts, so we skip to avoid duplicate terminal output.
  const withErrorLog =
    resolvedLogging.type === "file"
      ? baseEffect.pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const d = yield* Display;
              yield* d.status(
                formatErrorMessage(error as SandboxError),
                "error",
              );
            }),
          ),
        )
      : baseEffect;

  let result: OrchestrateResult;
  try {
    result = await Effect.runPromise(
      withErrorLog.pipe(Effect.provide(runLayer)),
    );
  } catch (error: unknown) {
    // If the signal was aborted, surface its reason verbatim (no wrapping)
    options.signal?.throwIfAborted();
    throw error;
  }

  const baseResult = {
    ...result,
    logFilePath:
      resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
  };

  // Extract structured output after the iteration completes (separate pass from completion signal)
  if (options.output) {
    const output = await extractStructuredOutput(
      baseResult.stdout,
      options.output,
      {
        commits: baseResult.commits,
        branch: baseResult.branch,
        preservedWorktreePath: baseResult.preservedWorktreePath,
      },
    );
    return { ...baseResult, output };
  }

  return baseResult;
}
