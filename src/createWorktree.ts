import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { hostSessionStore } from "./SessionStore.js";
import type { AgentProvider } from "./AgentProvider.js";
import { ClackDisplay, Display, FileDisplay } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { resolvePrompt } from "./PromptResolver.js";
import {
  SandboxFactory,
  makeSandboxLayerFromHandle,
  resolveGitMounts,
  SANDBOX_REPO_DIR,
} from "./SandboxFactory.js";
import {
  withSandboxLifecycle,
  runHostHooks,
  type SandboxHooks,
} from "./SandboxLifecycle.js";
import type {
  AnySandboxProvider,
  SandboxProvider,
  MergeToHeadBranchStrategy,
  NamedBranchStrategy,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import type { CloseResult, Sandbox } from "./createSandbox.js";
import { createSandboxFromWorktree } from "./createSandbox.js";
import type { InteractiveResult } from "./interactive.js";
import { buildLogFilename, printFileDisplayStartup } from "./run.js";
import type { LoggingOption } from "./run.js";
import { orchestrate, type IterationResult } from "./Orchestrator.js";
import { defaultSessionPathsLayer } from "./SessionPaths.js";
import {
  callbackAgentStreamEmitterLayer,
  noopAgentStreamEmitterLayer,
} from "./AgentStreamEmitter.js";
import { resolveEnv } from "./EnvResolver.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import { resolveCwd } from "./resolveCwd.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import { raceAbortSignal } from "./raceAbortSignal.js";
import type { Timeouts } from "./run.js";

/** Branch strategies valid for createWorktree — head is excluded. */
export type WorktreeBranchStrategy =
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

export interface CreateWorktreeOptions {
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

export interface WorktreeInteractiveOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-7")) */
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

export interface WorktreeRunOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-7")) */
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

export interface WorktreeRunResult {
  /** Per-iteration results (use `iterations.length` for the count). */
  readonly iterations: IterationResult[];
  /** The matched completion signal string, or undefined if none fired. */
  readonly completionSignal?: string;
  /** Combined stdout output from all agent iterations. */
  readonly stdout: string;
  /** List of commits made by the agent during the run. */
  readonly commits: { sha: string }[];
  /** The branch name the agent worked on. */
  readonly branch: string;
  /** Path to the log file, if logging was drained to a file. */
  readonly logFilePath?: string;
}

export interface WorktreeCreateSandboxOptions {
  /** Sandbox provider (e.g. docker({ imageName: "sandcastle:myrepo" })). */
  readonly sandbox: SandboxProvider;
  /** Lifecycle hooks grouped by execution location (host or sandbox). */
  readonly hooks?: SandboxHooks;
  /** Paths relative to the host repo root to copy into the worktree at creation time. */
  readonly copyToWorktree?: string[];
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
  /** @internal Test-only overrides to bypass the sandbox provider. */
  readonly _test?: {
    readonly buildSandboxLayer?: (
      sandboxDir: string,
    ) => import("effect").Layer.Layer<import("./SandboxFactory.js").Sandbox>;
  };
}

export interface Worktree {
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
export const createWorktree = async (
  options: CreateWorktreeOptions,
): Promise<Worktree> => {
  const branch =
    options.branchStrategy.type === "branch"
      ? options.branchStrategy.branch
      : undefined;

  const baseBranch =
    options.branchStrategy.type === "branch"
      ? options.branchStrategy.baseBranch
      : undefined;

  const { hostRepoDir, worktreeInfo } = await Effect.gen(function* () {
    const hostRepoDir = yield* resolveCwd(options.cwd);
    yield* WorktreeManager.pruneStale(hostRepoDir).pipe(
      Effect.catchAll(() => Effect.void),
    );
    const info = yield* WorktreeManager.create(hostRepoDir, {
      branch,
      baseBranch,
    });
    if (options.copyToWorktree && options.copyToWorktree.length > 0) {
      yield* copyToWorktree(options.copyToWorktree, hostRepoDir, info.path, options.timeouts?.copyToWorktreeMs);
    }
    // Run host.onWorktreeReady hooks after copyToWorktree, before sandbox creation
    if (options.hooks?.host?.onWorktreeReady?.length) {
      yield* runHostHooks(options.hooks.host.onWorktreeReady, info.path);
    }
    return { hostRepoDir, worktreeInfo: info };
  }).pipe(Effect.provide(NodeContext.layer), Effect.runPromise);

  let closed = false;

  const close = async (): Promise<CloseResult> => {
    if (closed) return { preservedWorktreePath: undefined };
    closed = true;

    return Effect.gen(function* () {
      const isDirty = yield* WorktreeManager.hasUncommittedChanges(
        worktreeInfo.path,
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (isDirty) {
        return { preservedWorktreePath: worktreeInfo.path } as CloseResult;
      }

      yield* WorktreeManager.remove(worktreeInfo.path).pipe(
        Effect.catchAll(() => Effect.void),
      );

      return { preservedWorktreePath: undefined } as CloseResult;
    }).pipe(Effect.runPromise);
  };

  const worktreeInteractive = async (
    opts: WorktreeInteractiveOptions,
  ): Promise<InteractiveResult> => {
    // If signal is already aborted, reject immediately without any setup
    opts.signal?.throwIfAborted();

    const { prompt, promptFile, hooks, agent: provider } = opts;
    const resolvedSandbox = opts.sandbox ?? noSandbox();

    // Validate buildInteractiveArgs is available
    if (!provider.buildInteractiveArgs) {
      throw new Error(
        `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
      );
    }

    const inner = Effect.gen(function* () {
      const d = yield* Display;

      // 1. Resolve prompt (from string or file), or skip if neither provided
      const hasPromptSource = prompt !== undefined || promptFile !== undefined;
      const resolved = hasPromptSource
        ? yield* resolvePrompt({ prompt, promptFile })
        : undefined;
      const rawPrompt = resolved?.text ?? "";
      const isInlinePrompt = resolved?.source === "inline";

      // 2. Resolve env vars
      const resolvedEnv = yield* resolveEnv(hostRepoDir);
      const env = mergeProviderEnv({
        resolvedEnv,
        agentProviderEnv: provider.env,
        sandboxProviderEnv: resolvedSandbox.env,
      });
      const effectiveEnv = { ...env, ...(opts.env ?? {}) };

      // 3. Prompt args substitution (skip when no prompt, or when inline passthrough)
      let substitutedPrompt = rawPrompt;
      if (hasPromptSource && !isInlinePrompt) {
        const userArgs = opts.promptArgs ?? {};
        yield* validateNoBuiltInArgOverride(userArgs);

        const effectiveArgs = {
          SOURCE_BRANCH: worktreeInfo.branch,
          TARGET_BRANCH: worktreeInfo.branch,
          ...userArgs,
        };
        const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
        substitutedPrompt = yield* substitutePromptArgs(
          rawPrompt,
          effectiveArgs,
          builtInArgKeysSet,
        );
      } else if (isInlinePrompt) {
        yield* validateNoArgsWithInlinePrompt(opts.promptArgs ?? {});
      }

      // Display intro
      yield* d.intro(opts.name ?? "sandcastle interactive");
      yield* d.summary("Interactive Session", {
        Agent: opts.name ?? provider.name,
        Sandbox: resolvedSandbox.name,
        Branch: worktreeInfo.branch,
      });

      // 4. Start sandbox
      let handle:
        | BindMountSandboxHandle
        | IsolatedSandboxHandle
        | NoSandboxHandle;

      if (resolvedSandbox.tag === "none") {
        handle = yield* Effect.promise(() =>
          resolvedSandbox.create({
            worktreePath: worktreeInfo.path,
            env: effectiveEnv,
          }),
        );
      } else if (resolvedSandbox.tag === "isolated") {
        const startResult = yield* d.taskLog("Starting sandbox", () =>
          startSandbox({
            provider: resolvedSandbox,
            hostRepoDir: worktreeInfo.path,
            env: effectiveEnv,
          }),
        );
        handle = startResult.handle;
      } else {
        const gitPath = join(hostRepoDir, ".git");
        const gitMounts = yield* resolveGitMounts(gitPath);
        const startResult = yield* d.taskLog("Starting sandbox", () =>
          startSandbox({
            provider: resolvedSandbox,
            hostRepoDir,
            env: effectiveEnv,
            worktreeOrRepoPath: worktreeInfo.path,
            gitMounts,
            repoDir: SANDBOX_REPO_DIR,
          }),
        );
        handle = startResult.handle;
      }

      // Run lifecycle — worktree owns worktree, so no worktree cleanup here
      return yield* Effect.gen(function* () {
        if (!handle.interactiveExec) {
          throw new Error(
            `Sandbox provider does not support interactiveExec. ` +
              `The provider must implement the optional interactiveExec method to use interactive().`,
          );
        }
        const interactiveExecFn = handle.interactiveExec.bind(handle);
        const sandboxLayer = makeSandboxLayerFromHandle(handle);
        const worktreePath = handle.worktreePath;

        const applyToHost =
          resolvedSandbox.tag === "isolated"
            ? () => syncOut(worktreeInfo.path, handle as IsolatedSandboxHandle)
            : () => Effect.void;

        const lifecycleEffect = withSandboxLifecycle(
          {
            hostRepoDir,
            sandboxRepoDir: worktreePath,
            hooks,
            branch: worktreeInfo.branch,
            hostWorktreePath: worktreeInfo.path,
            applyToHost,
          },
          (ctx) =>
            Effect.gen(function* () {
              const fullPrompt =
                !hasPromptSource || isInlinePrompt
                  ? substitutedPrompt
                  : yield* preprocessPrompt(
                      substitutedPrompt,
                      ctx.sandbox,
                      ctx.sandboxRepoDir,
                    );

              const interactiveArgs = provider.buildInteractiveArgs!({
                prompt: fullPrompt,
                dangerouslySkipPermissions: resolvedSandbox.tag !== "none",
              });

              const result = yield* raceAbortSignal(
                Effect.promise(() =>
                  interactiveExecFn(interactiveArgs, {
                    stdin: process.stdin,
                    stdout: process.stdout,
                    stderr: process.stderr,
                    cwd: worktreePath,
                  }),
                ),
                opts.signal,
              );

              return result.exitCode;
            }),
        );

        const lifecycleResult = yield* lifecycleEffect.pipe(
          Effect.provide(sandboxLayer),
        );

        const exitCode = lifecycleResult.result;

        // Summary
        yield* d.summary("Session Complete", {
          Commits: String(lifecycleResult.commits.length),
          Branch: lifecycleResult.branch,
          "Exit code": String(exitCode),
        });

        return {
          commits: lifecycleResult.commits,
          branch: lifecycleResult.branch,
          preservedWorktreePath: undefined,
          exitCode,
        } satisfies InteractiveResult;
      }).pipe(
        // Always close sandbox handle
        Effect.ensuring(Effect.promise(() => handle.close().catch(() => {}))),
      );
    });

    try {
      return await Effect.runPromise(
        inner.pipe(
          Effect.provide(ClackDisplay.layer),
          Effect.provide(NodeContext.layer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );
    } catch (error: unknown) {
      // If the signal was aborted, surface its reason verbatim (no wrapping)
      opts.signal?.throwIfAborted();
      throw error;
    }
  };

  const worktreeRun = async (
    opts: WorktreeRunOptions,
  ): Promise<WorktreeRunResult> => {
    // If signal is already aborted, reject immediately without any setup
    opts.signal?.throwIfAborted();

    const { prompt, promptFile, hooks, agent: provider } = opts;
    const sandboxProvider = opts.sandbox;
    const maxIterations = opts.maxIterations ?? 1;

    if (opts.resumeSession && maxIterations > 1) {
      throw new Error(
        "resumeSession cannot be combined with maxIterations > 1. " +
          "Resume applies to iteration 1 only; multi-iteration resume semantics are not supported.",
      );
    }

    if (opts.resumeSession) {
      const hStore = hostSessionStore(hostRepoDir);
      const sessionPath = hStore.sessionFilePath(opts.resumeSession);
      if (!existsSync(sessionPath)) {
        throw new Error(
          `resumeSession "${opts.resumeSession}" not found: expected session file at ${sessionPath}`,
        );
      }
    }

    const inner = Effect.gen(function* () {
      // 1. Resolve prompt
      const resolved = yield* resolvePrompt({ prompt, promptFile });
      const rawPrompt = resolved.text;
      const isInlinePrompt = resolved.source === "inline";

      // 2. Resolve env vars
      const resolvedEnv = yield* resolveEnv(hostRepoDir);
      const env = mergeProviderEnv({
        resolvedEnv,
        agentProviderEnv: provider.env,
        sandboxProviderEnv: sandboxProvider.env,
      });
      const effectiveEnv = { ...env, ...(opts.env ?? {}) };

      // 3. Prompt args substitution (skipped for inline prompts — passthrough)
      const userArgs = opts.promptArgs ?? {};
      let resolvedPrompt: string;
      if (isInlinePrompt) {
        yield* validateNoArgsWithInlinePrompt(userArgs);
        resolvedPrompt = rawPrompt;
      } else {
        yield* validateNoBuiltInArgOverride(userArgs);
        const effectiveArgs = {
          SOURCE_BRANCH: worktreeInfo.branch,
          TARGET_BRANCH: worktreeInfo.branch,
          ...userArgs,
        };
        const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
        resolvedPrompt = yield* substitutePromptArgs(
          rawPrompt,
          effectiveArgs,
          builtInArgKeysSet,
        );
      }

      // 4. Start sandbox
      let handle: BindMountSandboxHandle | IsolatedSandboxHandle;
      let sandboxRepoDir: string;

      if (sandboxProvider.tag === "isolated") {
        const startResult = yield* startSandbox({
          provider: sandboxProvider,
          hostRepoDir: worktreeInfo.path,
          env: effectiveEnv,
        });
        handle = startResult.handle;
        sandboxRepoDir = startResult.worktreePath;
      } else {
        const gitPath = join(hostRepoDir, ".git");
        const gitMounts = yield* resolveGitMounts(gitPath);
        const startResult = yield* startSandbox({
          provider: sandboxProvider,
          hostRepoDir,
          env: effectiveEnv,
          worktreeOrRepoPath: worktreeInfo.path,
          gitMounts,
          repoDir: SANDBOX_REPO_DIR,
        });
        handle = startResult.handle;
        sandboxRepoDir = startResult.worktreePath;
      }

      const sandboxLayer = makeSandboxLayerFromHandle(handle);
      const applyToHost =
        sandboxProvider.tag === "isolated"
          ? () => syncOut(worktreeInfo.path, handle as IsolatedSandboxHandle)
          : () => Effect.void;

      // 5. Resolve logging
      const resolvedLogging: LoggingOption = opts.logging ?? {
        type: "file",
        path: join(
          hostRepoDir,
          ".sandcastle",
          "logs",
          buildLogFilename(worktreeInfo.branch, undefined, opts.name),
        ),
      };

      const runDisplayLayer =
        resolvedLogging.type === "file"
          ? (() => {
              printFileDisplayStartup({
                logPath: resolvedLogging.path,
                agentName: opts.name,
                branch: worktreeInfo.branch,
              });
              return Layer.provide(
                FileDisplay.layer(resolvedLogging.path),
                NodeFileSystem.layer,
              );
            })()
          : ClackDisplay.layer;

      // 6. Build a SandboxFactory that reuses the started sandbox
      const reuseFactoryLayer = Layer.succeed(SandboxFactory, {
        withSandbox: (makeEffect) =>
          makeEffect({
            hostWorktreePath: worktreeInfo.path,
            sandboxRepoPath: sandboxRepoDir,
            applyToHost,
          }).pipe(
            Effect.provide(sandboxLayer),
            Effect.map((value) => ({
              value,
              preservedWorktreePath: undefined,
            })),
          ) as any,
      });

      const agentStreamEmitterLayer =
        resolvedLogging.type === "file" && resolvedLogging.onAgentStreamEvent
          ? callbackAgentStreamEmitterLayer(resolvedLogging.onAgentStreamEvent)
          : noopAgentStreamEmitterLayer;

      const runLayer = Layer.mergeAll(
        reuseFactoryLayer,
        runDisplayLayer,
        defaultSessionPathsLayer,
        agentStreamEmitterLayer,
      );

      // 7. Run orchestration
      const result = yield* Effect.gen(function* () {
        const display = yield* Display;
        yield* display.intro(opts.name ?? "sandcastle");

        return yield* orchestrate({
          hostRepoDir,
          iterations: maxIterations,
          hooks,
          prompt: resolvedPrompt,
          branch: worktreeInfo.branch,
          provider,
          completionSignal: opts.completionSignal,
          idleTimeoutSeconds: opts.idleTimeoutSeconds,
          name: opts.name,
          resumeSession: opts.resumeSession,
          signal: opts.signal,
          skipPromptExpansion: isInlinePrompt,
        });
      }).pipe(
        Effect.provide(runLayer),
        // Always close sandbox handle
        Effect.ensuring(Effect.promise(() => handle.close().catch(() => {}))),
      );

      return {
        iterations: result.iterations,
        completionSignal: result.completionSignal,
        stdout: result.stdout,
        commits: result.commits,
        branch: result.branch,
        logFilePath:
          resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
      } satisfies WorktreeRunResult;
    });

    try {
      return await Effect.runPromise(
        inner.pipe(
          Effect.provide(ClackDisplay.layer),
          Effect.provide(NodeContext.layer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );
    } catch (error: unknown) {
      // If the signal was aborted, surface its reason verbatim (no wrapping)
      opts.signal?.throwIfAborted();
      throw error;
    }
  };

  const worktreeCreateSandbox = async (
    opts: WorktreeCreateSandboxOptions,
  ): Promise<Sandbox> => {
    return createSandboxFromWorktree({
      branch: worktreeInfo.branch,
      worktreePath: worktreeInfo.path,
      hostRepoDir,
      sandbox: opts.sandbox,
      hooks: opts.hooks,
      copyToWorktree: opts.copyToWorktree,
      timeouts: opts.timeouts,
      _test: opts._test,
    });
  };

  return {
    branch: worktreeInfo.branch,
    worktreePath: worktreeInfo.path,
    run: worktreeRun,
    interactive: worktreeInteractive,
    createSandbox: worktreeCreateSandbox,
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
};
