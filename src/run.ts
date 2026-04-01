import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import path, { join } from "node:path";
import { styleText } from "node:util";
import { Effect, Layer } from "effect";
import { getAgentProvider } from "./AgentProvider.js";
import {
  ClackDisplay,
  Display,
  FileDisplay,
  type Severity,
} from "./Display.js";
import { orchestrate } from "./Orchestrator.js";
import { resolvePrompt } from "./PromptResolver.js";
import {
  WorktreeDockerSandboxFactory,
  WorktreeSandboxConfig,
  SANDBOX_WORKSPACE_DIR,
} from "./SandboxFactory.js";
import { resolveEnv } from "./EnvResolver.js";
import { generateTempBranchName, getCurrentBranch } from "./WorktreeManager.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";

/** Default maximum number of iterations for a run. */
export const DEFAULT_MAX_ITERATIONS = 1;

/** Default agent provider name. */
export const DEFAULT_AGENT = "claude-code";

/** Replace characters that are invalid or problematic in file paths with dashes. */
export const sanitizeBranchForFilename = (branch: string): string =>
  branch.replace(/[/\\:*?"<>|]/g, "-");

export interface FileDisplayStartupOptions {
  readonly logPath: string;
  readonly agentName?: string;
  readonly branch?: string;
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
  const relativeLogPath = path.relative(process.cwd(), options.logPath);
  console.log(`${label} Started${branchPart}`);
  console.log(styleText("dim", `  tail -f ${relativeLogPath}`));
};

/**
 * Derive the default Docker image name from the repo directory.
 * Returns `sandcastle:<dir-name>` where dir-name is the last path segment,
 * lowercased and sanitized for Docker image tag rules.
 */
export const defaultImageName = (repoDir: string): string => {
  const dirName = repoDir.replace(/\/+$/, "").split("/").pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized}`;
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
  readonly imageName: string;
  readonly maxIterations: number;
  readonly branch: string;
  readonly model?: string;
}

/**
 * Build the summary rows for a run, used in both terminal mode and
 * log-to-file mode. When a custom name is provided it appears as the
 * Agent value instead of the internal provider name.
 */
export const buildRunSummaryRows = (
  options: RunSummaryRowsOptions,
): Record<string, string> => {
  const rows: Record<string, string> = {
    Agent: options.name ?? options.agentName,
    Image: options.imageName,
    "Max iterations": String(options.maxIterations),
    Branch: options.branch,
  };
  if (options.model) rows["Model"] = options.model;
  return rows;
};

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
 * Controls where Sandcastle writes iteration progress and agent output.
 * Use `"file"` (log-to-file mode) to write to a log file on disk, or
 * `"stdout"` (terminal mode) to render an interactive UI in the terminal.
 */
export type LoggingOption =
  /** Write progress and agent output to a log file at the given path (log-to-file mode). */
  | { readonly type: "file"; readonly path: string }
  /** Render progress and agent output as an interactive UI in the terminal (terminal mode). */
  | { readonly type: "stdout" };

export interface RunOptions {
  /** Inline prompt string (mutually exclusive with promptFile) */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt) */
  readonly promptFile?: string;
  /** Maximum iterations to run (default: 1) */
  readonly maxIterations?: number;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: {
    readonly onSandboxReady?: ReadonlyArray<{ command: string }>;
  };
  /** Target branch name for sandbox work */
  readonly branch?: string;
  /** Model to use for the agent (default: provider-specific) */
  readonly model?: string;
  /** Docker image name to use for the sandbox (default: sandcastle:<repo-dir-name>) */
  readonly imageName?: string;
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Logging mode (default: { type: 'file' } with auto-generated path under .sandcastle/logs/) */
  readonly logging?: LoggingOption;
  /** Substring(s) the agent emits to stop the iteration loop early. Matched via `includes` against agent output. (default: `"<promise>COMPLETE</promise>"`) */
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. If the agent produces no output for this long, it fails. Default: 300 (5 minutes) */
  readonly idleTimeoutSeconds?: number;
  /** Optional name for the run, shown as a prefix in log output */
  readonly name?: string;
  /** Paths relative to the host repo root to copy into the worktree before container start. */
  readonly copyToSandbox?: string[];
  /** Agent provider to use (default: "claude-code"). Available: "claude-code", "pi" */
  readonly agent?: "claude-code" | "pi" | (string & {});
}

export interface RunResult {
  /** Number of iterations the agent completed during this run. */
  readonly iterationsRun: number;
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

export const run = async (options: RunOptions): Promise<RunResult> => {
  const {
    prompt,
    promptFile,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    hooks,
    branch,
    model,
  } = options;

  const hostRepoDir = process.cwd();

  // Resolve prompt
  const rawPrompt = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile }).pipe(
      Effect.provide(NodeContext.layer),
    ),
  );

  // Resolve agent provider
  const agentName = options.agent ?? DEFAULT_AGENT;
  const provider = getAgentProvider(agentName);

  // Model resolution: explicit option is passed through to orchestrate(),
  // which falls back to provider.defaultModel when undefined.
  const resolvedModel = model;

  // Resolve image name: explicit option > default
  const resolvedImageName = options.imageName ?? defaultImageName(hostRepoDir);

  // Resolve env vars
  const env = await Effect.runPromise(
    resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
  );

  // When no branch is provided, generate a temporary branch name.
  // This names the log file after the temp branch and also directs
  // the sandbox to work on that branch (instead of the current host branch).
  const resolvedBranch = branch ?? generateTempBranchName(agentName);

  // Always capture the host's current branch for the TARGET_BRANCH built-in
  // prompt argument. When using a temp branch, it also prefixes the log filename.
  const currentHostBranch = await Effect.runPromise(
    getCurrentBranch(hostRepoDir),
  );

  // When using a temp branch, prefix the log filename with the target branch
  // (the host's current branch) so developers can tell which branch was targeted.
  const targetBranch = branch === undefined ? currentHostBranch : undefined;

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
            agentName: options.name ?? agentName,
            branch: resolvedBranch,
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
      Layer.succeed(WorktreeSandboxConfig, {
        imageName: resolvedImageName,
        env,
        hostRepoDir,
        // Pass explicit branch only — when undefined, WorktreeManager creates a temp branch
        // and SandboxLifecycle cherry-picks commits onto the host's current branch
        branch,
        copyToSandbox: options.copyToSandbox,
        agentName,
      }),
      NodeFileSystem.layer,
      displayLayer,
    ),
  );

  const runLayer = Layer.merge(factoryLayer, displayLayer);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const d = yield* Display;
      yield* d.intro(options.name ?? "sandcastle");
      const rows = buildRunSummaryRows({
        name: options.name,
        agentName,
        imageName: resolvedImageName,
        maxIterations,
        branch: resolvedBranch,
        model: resolvedModel,
      });
      yield* d.summary("Sandcastle Run", rows);

      // Validate that the user has not provided built-in prompt argument keys
      const userArgs = options.promptArgs ?? {};
      yield* validateNoBuiltInArgOverride(userArgs);

      // Build effective args: built-in args merged with user-provided args.
      // Built-in keys are silenced so they don't trigger unused-arg warnings.
      const effectiveArgs = {
        SOURCE_BRANCH: resolvedBranch,
        TARGET_BRANCH: currentHostBranch,
        ...userArgs,
      };
      const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
      const resolvedPrompt = yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet,
      );

      const orchestrateResult = yield* orchestrate({
        hostRepoDir,
        sandboxRepoDir: SANDBOX_WORKSPACE_DIR,
        iterations: maxIterations,
        hooks,
        prompt: resolvedPrompt,
        branch,
        model: resolvedModel,
        completionSignal: options.completionSignal,
        idleTimeoutSeconds: options.idleTimeoutSeconds,
        name: options.name,
        agentProvider: provider,
      });

      const completion = buildCompletionMessage(
        orchestrateResult.completionSignal,
        orchestrateResult.iterationsRun,
      );
      yield* d.status(completion.message, completion.severity);

      return orchestrateResult;
    }).pipe(Effect.provide(runLayer)),
  );

  return {
    ...result,
    logFilePath:
      resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
  };
};
