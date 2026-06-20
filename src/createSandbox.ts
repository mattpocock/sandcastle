import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { join } from "node:path";
import { Effect, Layer, Ref } from "effect";
import type { AgentProvider } from "./AgentProvider.js";
import {
  ClackDisplay,
  Display,
  FileDisplay,
  SilentDisplay,
  type DisplayEntry,
} from "./Display.js";
import { resolveEnv } from "./EnvResolver.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { orchestrate, type IterationResult } from "./Orchestrator.js";
import { agentStreamEmitterLayer } from "./AgentStreamEmitter.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import { resolvePrompt } from "./PromptResolver.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import type { LoggingOption, Timeouts } from "./run.js";
import {
  buildAgentStreamHandler,
  buildCompletionMessage,
  buildContextWindowLines,
  buildLogFilename,
  printFileDisplayStartup,
} from "./run.js";
import {
  withSandboxLifecycle,
  runHostHooks,
  type SandboxHooks,
} from "./SandboxLifecycle.js";
import {
  type SandboxService,
  SandboxFactory,
  SANDBOX_REPO_DIR,
  resolveGitMounts,
  makeSandboxFromHandle,
} from "./SandboxFactory.js";
import type {
  SandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
  MergeToHeadBranchStrategy,
  NamedBranchStrategy,
  ExecResult,
} from "./SandboxProvider.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import { resolveCwd } from "./resolveCwd.js";
import { patchGitMountsForWindows } from "./mountUtils.js";
import { assertResumeSessionExists } from "./resumePrecheck.js";
import { registerShutdown } from "./shutdownRegistry.js";

export interface CreateSandboxOptions {
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
  /** @internal Test-only overrides to bypass the sandbox provider. */
  readonly _test?: {
    readonly buildSandbox?: (sandboxDir: string) => SandboxService;
    /**
     * Fake bind-mount handle exposed to the orchestrator's session-capture path.
     * Only honored when `sandbox.tag === "bind-mount"`. Used to exercise the
     * `bindMountHandle` flow in tests without booting a real container.
     */
    readonly bindMountHandle?: BindMountSandboxHandle;
  };
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
export interface ResumeSandboxRunResultOptions {
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

export interface SandboxRunOptions extends ResumeSandboxRunResultOptions {
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
  /**
   * When true alongside `resumeSession`, fork the session instead of mutating
   * it. The parent session JSONL is left intact and the agent writes a new
   * session under a fresh id. Exposed as the public `.fork()` method on
   * `SandboxRunResult` rather than as a stand-alone caller option — see
   * ADR 0018.
   *
   * @internal
   */
  readonly forkSession?: boolean;
}

export interface SandboxRunResult {
  /** Per-iteration results (use `iterations.length` for the count). */
  readonly iterations: IterationResult[];
  /** The matched completion signal string, or undefined if none fired. */
  readonly completionSignal?: string;
  /** Combined stdout output from all agent iterations. */
  readonly stdout: string;
  /** List of commits made by the agent during the run. */
  readonly commits: { sha: string }[];
  /** Path to the log file, if logging was drained to a file. */
  readonly logFilePath?: string;
  /**
   * Continue the last captured agent session for exactly one iteration inside
   * the same long-lived sandbox. Present only when the provider supports
   * resume (`sessionStorage` populated) and a session id was captured.
   */
  readonly resume?: (
    prompt: string,
    options?: ResumeSandboxRunResultOptions,
  ) => Promise<SandboxRunResult>;
  /**
   * Fork the last captured agent session for exactly one iteration inside the
   * same long-lived sandbox: the parent session JSONL is left intact and the
   * child run gets its own session id. Present only when the provider
   * supports resume (`sessionStorage` populated) and a session id was
   * captured. See ADR 0018 for fork semantics.
   */
  readonly fork?: (
    prompt: string,
    options?: ResumeSandboxRunResultOptions,
  ) => Promise<SandboxRunResult>;
}

export interface SandboxInteractiveOptions {
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

export interface SandboxInteractiveResult {
  /** List of commits made during the interactive session. */
  readonly commits: { sha: string }[];
  /** Exit code of the interactive process. */
  readonly exitCode: number;
}

export interface CloseResult {
  /** Host path to the preserved worktree, set when the worktree had uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

export interface Sandbox {
  /** The branch the worktree is on. */
  readonly branch: string;
  /** Host path to the worktree. */
  readonly worktreePath: string;
  /** Invoke an agent inside the existing sandbox. */
  run(options: SandboxRunOptions): Promise<SandboxRunResult>;
  /** Launch an interactive agent session inside the existing sandbox. */
  interactive(
    options: SandboxInteractiveOptions,
  ): Promise<SandboxInteractiveResult>;
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
export interface SandboxExecOptions {
  /** Per-line stdout callback for streaming output. */
  readonly onLine?: (line: string) => void;
  /** Working directory for the command. Defaults to the sandbox repo path. */
  readonly cwd?: string;
  /** Run the command with sudo, when the provider supports it. */
  readonly sudo?: boolean;
  /** Stdin payload — piped to the child process and then closed. Avoids the Linux 128 KB per-arg limit. */
  readonly stdin?: string;
}

/** @internal Context for building Sandbox handle methods. */
interface SandboxHandleContext {
  readonly branch: string;
  readonly worktreePath: string;
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly sandbox: SandboxService;
  readonly providerHandle:
    | BindMountSandboxHandle
    | IsolatedSandboxHandle
    | NoSandboxHandle
    | undefined;
  /**
   * Pre-narrowed bind-mount handle, set when the provider is a bind-mount
   * provider. Required by the orchestrator's session capture path
   * (`AgentSessionStorage.captureToHost/resumeIntoSandbox`), which is typed
   * on `BindMountSandboxHandle` and calls `copyFileOut`/`copyFileIn` —
   * methods that no-sandbox and isolated handles do not implement.
   */
  readonly bindMountHandle: BindMountSandboxHandle | undefined;
  /** Provider tag, used by resumeSession to dispatch the host-side session lookup. */
  readonly providerTag: SandboxProvider["tag"];
  readonly applyToHost: () => Effect.Effect<void, any>;
  readonly timeouts?: Timeouts;
  /** Worktree branch strategy. Set only when the handle is backed by a
   *  `createWorktree(...)` handle; absent for top-level `createSandbox()`,
   *  which is always explicit-branch. When `type === "merge-to-head"`, each
   *  run()/interactive() routes through the lifecycle's merge step and the
   *  worktree's source branch is preserved across calls. */
  readonly branchStrategy?: MergeToHeadBranchStrategy | NamedBranchStrategy;
}

/**
 * @internal Builds a Sandbox handle with run() and interactive() methods.
 * The close callback controls teardown behavior — top-level createSandbox()
 * cleans up both container and worktree, while worktree-backed sandboxes
 * only tear down the container.
 */
const buildSandboxHandle = (
  ctx: SandboxHandleContext,
  close: () => Promise<CloseResult>,
): Sandbox => {
  const {
    branch,
    worktreePath,
    hostRepoDir,
    sandboxRepoDir,
    sandbox,
    providerHandle,
    bindMountHandle,
    applyToHost,
    timeouts,
    branchStrategy,
  } = ctx;
  // Routing for the lifecycle: in merge-to-head mode pass `branch: undefined`
  // (so the lifecycle records host's current branch and merges back) and keep
  // the worktree's source branch alive for subsequent calls. In all other
  // cases (top-level createSandbox, named-branch worktree) forward `branch`
  // as-is and let the lifecycle delete the temp branch normally.
  const mergeToHead = branchStrategy?.type === "merge-to-head";

  const sandboxHandle: Sandbox = {
    branch,
    worktreePath: worktreePath,

    run: async (runOptions: SandboxRunOptions): Promise<SandboxRunResult> => {
      // If signal is already aborted, reject immediately without any setup
      runOptions.signal?.throwIfAborted();

      const {
        agent: provider,
        prompt,
        promptFile,
        maxIterations = 1,
      } = runOptions;

      // Validate: resumeSession + maxIterations > 1 is not allowed.
      if (runOptions.resumeSession && maxIterations > 1) {
        throw new Error(
          "resumeSession cannot be combined with maxIterations > 1. " +
            "Resume applies to iteration 1 only; multi-iteration resume semantics are not supported.",
        );
      }

      // Validate: forkSession only makes sense alongside resumeSession.
      if (runOptions.forkSession && !runOptions.resumeSession) {
        throw new Error(
          "forkSession requires resumeSession. " +
            "Use sandboxRunResult.fork(prompt) to fork the most recent captured session.",
        );
      }

      // Validate: resumeSession file must exist on the host before launching.
      if (runOptions.resumeSession) {
        await assertResumeSessionExists({
          provider,
          sandboxTag: ctx.providerTag,
          hostRepoDir,
          resumeSession: runOptions.resumeSession,
        });
      }

      const resolved = await Effect.runPromise(
        resolvePrompt({ prompt, promptFile }).pipe(
          Effect.provide(NodeContext.layer),
        ),
      );
      const rawPrompt = resolved.text;
      const isInlinePrompt = resolved.source === "inline";

      const userArgs = runOptions.promptArgs ?? {};
      const currentHostBranch = await Effect.runPromise(
        WorktreeManager.getCurrentBranch(hostRepoDir),
      );

      const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
      const silentDisplayLayer = SilentDisplay.layer(displayRef);

      const resolvedPrompt = await Effect.runPromise(
        Effect.gen(function* () {
          if (isInlinePrompt) {
            yield* validateNoArgsWithInlinePrompt(userArgs);
            return rawPrompt;
          }
          yield* validateNoBuiltInArgOverride(userArgs);
          const effectiveArgs = {
            SOURCE_BRANCH: branch,
            TARGET_BRANCH: currentHostBranch,
            ...userArgs,
          };
          const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
          return yield* substitutePromptArgs(
            rawPrompt,
            effectiveArgs,
            builtInArgKeysSet,
          );
        }).pipe(Effect.provide(silentDisplayLayer)),
      );

      const resolvedLogging: LoggingOption = runOptions.logging ?? {
        type: "file",
        path: join(
          hostRepoDir,
          ".sandcastle",
          "logs",
          buildLogFilename(branch, undefined, runOptions.name),
        ),
      };

      const runDisplayLayer =
        resolvedLogging.type === "file"
          ? (() => {
              printFileDisplayStartup({
                logPath: resolvedLogging.path,
                agentName: runOptions.name,
                branch,
              });
              return Layer.provide(
                FileDisplay.layer(resolvedLogging.path),
                NodeFileSystem.layer,
              );
            })()
          : silentDisplayLayer;

      const reuseFactoryLayer = Layer.succeed(SandboxFactory, {
        withSandbox: (makeEffect) =>
          makeEffect(
            {
              hostWorktreePath: worktreePath,
              sandboxRepoPath: sandboxRepoDir,
              applyToHost,
              bindMountHandle,
            },
            sandbox,
          ).pipe(
            Effect.map((value) => ({
              value,
              preservedWorktreePath: undefined,
            })),
          ) as any,
      });

      const streamEmitterLayer = agentStreamEmitterLayer(
        buildAgentStreamHandler(resolvedLogging),
      );

      const runLayer = Layer.mergeAll(
        reuseFactoryLayer,
        runDisplayLayer,
        streamEmitterLayer,
      );

      let result;
      try {
        result = await Effect.runPromise(
          Effect.gen(function* () {
            const display = yield* Display;
            yield* display.intro(runOptions.name ?? "sandcastle");

            const orchestrateResult = yield* orchestrate({
              hostRepoDir,
              iterations: maxIterations,
              prompt: resolvedPrompt,
              branch: mergeToHead ? undefined : branch,
              provider,
              completionSignal: runOptions.completionSignal,
              idleTimeoutSeconds: runOptions.idleTimeoutSeconds,
              completionTimeoutSeconds: runOptions.completionTimeoutSeconds,
              name: runOptions.name,
              resumeSession: runOptions.resumeSession,
              forkSession: runOptions.forkSession,
              signal: runOptions.signal,
              skipPromptExpansion: isInlinePrompt,
              timeouts,
              keepSourceBranch: mergeToHead,
            });

            const completion = buildCompletionMessage(
              orchestrateResult.completionSignal,
              orchestrateResult.iterations.length,
            );
            yield* display.status(completion.message, completion.severity);

            for (const line of buildContextWindowLines(
              orchestrateResult.iterations,
            )) {
              yield* display.text(line);
            }

            return orchestrateResult;
          }).pipe(Effect.provide(runLayer)),
        );
      } catch (error: unknown) {
        // If the signal was aborted, surface its reason verbatim
        runOptions.signal?.throwIfAborted();
        throw error;
      }

      const baseResult: SandboxRunResult = {
        iterations: result.iterations,
        completionSignal: result.completionSignal,
        stdout: result.stdout,
        commits: result.commits,
        logFilePath:
          resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
      };

      // Expose .resume()/.fork() only when the provider supports session
      // capture and a session id was actually captured on the last iteration.
      // The functions re-enter the same long-lived sandbox by calling
      // sandboxHandle.run() — container and worktree stay warm.
      const lastIteration = result.iterations.at(-1);
      if (provider.sessionStorage && lastIteration?.sessionId) {
        const capturedSessionId = lastIteration.sessionId;
        return {
          ...baseResult,
          resume: (
            nextPrompt: string,
            resumeOptions?: ResumeSandboxRunResultOptions,
          ): Promise<SandboxRunResult> =>
            sandboxHandle.run({
              ...runOptions,
              ...resumeOptions,
              prompt: nextPrompt,
              promptFile: undefined,
              maxIterations: 1,
              resumeSession: capturedSessionId,
            }),
          fork: (
            nextPrompt: string,
            forkOptions?: ResumeSandboxRunResultOptions,
          ): Promise<SandboxRunResult> =>
            sandboxHandle.run({
              ...runOptions,
              ...forkOptions,
              prompt: nextPrompt,
              promptFile: undefined,
              maxIterations: 1,
              resumeSession: capturedSessionId,
              forkSession: true,
            }),
        };
      }

      return baseResult;
    },

    interactive: async (
      interactiveOptions: SandboxInteractiveOptions,
    ): Promise<SandboxInteractiveResult> => {
      // If signal is already aborted, reject immediately without any setup
      interactiveOptions.signal?.throwIfAborted();

      const { agent: provider, prompt, promptFile } = interactiveOptions;

      if (!provider.buildInteractiveArgs) {
        throw new Error(
          `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
        );
      }

      if (!providerHandle?.interactiveExec) {
        throw new Error(
          `Sandbox provider does not support interactiveExec. ` +
            `The provider must implement the optional interactiveExec method to use interactive().`,
        );
      }
      const interactiveExecFn =
        providerHandle.interactiveExec.bind(providerHandle);

      let lifecycleResult;
      try {
        lifecycleResult = await Effect.runPromise(
          Effect.gen(function* () {
            const resolved = yield* resolvePrompt({ prompt, promptFile });
            const rawPrompt = resolved.text;
            const isInlinePrompt = resolved.source === "inline";

            const userArgs = interactiveOptions.promptArgs ?? {};
            const currentHostBranch =
              yield* WorktreeManager.getCurrentBranch(hostRepoDir);

            let resolvedPrompt: string;
            if (isInlinePrompt) {
              yield* validateNoArgsWithInlinePrompt(userArgs);
              resolvedPrompt = rawPrompt;
            } else {
              yield* validateNoBuiltInArgOverride(userArgs);
              const effectiveArgs = {
                SOURCE_BRANCH: branch,
                TARGET_BRANCH: currentHostBranch,
                ...userArgs,
              };
              const builtInArgKeysSet = new Set<string>(
                BUILT_IN_PROMPT_ARG_KEYS,
              );
              resolvedPrompt = yield* substitutePromptArgs(
                rawPrompt,
                effectiveArgs,
                builtInArgKeysSet,
              );
            }

            return yield* withSandboxLifecycle(
              {
                hostRepoDir,
                sandboxRepoDir,
                branch: mergeToHead ? undefined : branch,
                hostWorktreePath: worktreePath,
                applyToHost,
                timeouts,
                keepSourceBranch: mergeToHead,
              },
              sandbox,
              (ctx) =>
                Effect.gen(function* () {
                  const fullPrompt = isInlinePrompt
                    ? resolvedPrompt
                    : yield* preprocessPrompt(
                        resolvedPrompt,
                        ctx.sandbox,
                        ctx.sandboxRepoDir,
                      );

                  const interactiveArgs = provider.buildInteractiveArgs!({
                    prompt: fullPrompt,
                    dangerouslySkipPermissions: true,
                  });
                  const execPromise = interactiveExecFn(interactiveArgs, {
                    stdin: process.stdin,
                    stdout: process.stdout,
                    stderr: process.stderr,
                    cwd: sandboxRepoDir,
                  });

                  // Race exec with abort signal if provided
                  const signal = interactiveOptions.signal;
                  const result = yield* Effect.promise(() => {
                    if (!signal) return execPromise;
                    if (signal.aborted) return Promise.reject(signal.reason);
                    return new Promise<{ exitCode: number }>(
                      (resolve, reject) => {
                        const onAbort = () => reject(signal.reason);
                        signal.addEventListener("abort", onAbort, {
                          once: true,
                        });
                        execPromise.then(
                          (r) => {
                            signal.removeEventListener("abort", onAbort);
                            resolve(r);
                          },
                          (e) => {
                            signal.removeEventListener("abort", onAbort);
                            reject(e);
                          },
                        );
                      },
                    );
                  });

                  return result.exitCode;
                }),
            );
          }).pipe(
            Effect.provide(ClackDisplay.layer),
            Effect.provide(NodeContext.layer),
          ),
        );
      } catch (error: unknown) {
        // If the signal was aborted, surface its reason verbatim
        interactiveOptions.signal?.throwIfAborted();
        throw error;
      }

      return {
        commits: lifecycleResult.commits,
        exitCode: lifecycleResult.result,
      };
    },

    exec: async (
      command: string,
      options?: SandboxExecOptions,
    ): Promise<ExecResult> => {
      const mergedOptions = { cwd: sandboxRepoDir, ...options };
      if (providerHandle) {
        return providerHandle.exec(command, mergedOptions);
      }
      // Test-mode fallback: no providerHandle, only the Effect SandboxService.
      return Effect.runPromise(sandbox.exec(command, mergedOptions));
    },

    close: async (): Promise<CloseResult> => close(),

    [Symbol.asyncDispose]: async (): Promise<void> => {
      await sandboxHandle.close();
    },
  };

  return sandboxHandle;
};

/** @internal Options for createSandboxFromWorktree — used by worktree.createSandbox(). */
export interface CreateSandboxFromWorktreeOptions {
  readonly branch: string;
  readonly worktreePath: string;
  readonly hostRepoDir: string;
  readonly sandbox: SandboxProvider;
  readonly hooks?: SandboxHooks;
  readonly copyToWorktree?: string[];
  readonly timeouts?: Timeouts;
  /** Forwarded to the Sandbox handle. Set by `createWorktree` so the handle
   *  can route run()/interactive() correctly: for `merge-to-head`, each call
   *  merges back to the host's current branch and the worktree's source
   *  branch is preserved; for `branch`, the lifecycle is driven as
   *  explicit-branch mode. Absent for top-level `createSandbox()`. */
  readonly branchStrategy?: MergeToHeadBranchStrategy | NamedBranchStrategy;
  readonly _test?: {
    readonly buildSandbox?: (sandboxDir: string) => SandboxService;
    /**
     * Fake bind-mount handle exposed to the orchestrator's session-capture path.
     * Only honored when `sandbox.tag === "bind-mount"`.
     */
    readonly bindMountHandle?: BindMountSandboxHandle;
  };
}

/**
 * @internal Creates a sandbox backed by an existing worktree.
 * Split ownership: close() tears down the container only, leaving the worktree intact.
 * Used by Worktree.createSandbox().
 */
export const createSandboxFromWorktree = async (
  options: CreateSandboxFromWorktreeOptions,
): Promise<Sandbox> => {
  const { branch, worktreePath, hostRepoDir } = options;
  const isTestMode = !!options._test?.buildSandbox;

  // 1. Copy files if requested (bind-mount only)
  if (
    options.copyToWorktree &&
    options.copyToWorktree.length > 0 &&
    options.sandbox.tag !== "isolated"
  ) {
    await Effect.runPromise(
      copyToWorktree(
        options.copyToWorktree,
        hostRepoDir,
        worktreePath,
        options.timeouts?.copyToWorktreeMs,
      ),
    );
  }

  // 2. Start sandbox via provider or local sandbox layer (test mode)
  let providerHandle:
    | BindMountSandboxHandle
    | IsolatedSandboxHandle
    | NoSandboxHandle
    | undefined;
  let sandbox: SandboxService;
  let sandboxRepoDir: string;
  const isIsolated = options.sandbox.tag === "isolated";

  if (isTestMode) {
    sandbox = options._test!.buildSandbox!(worktreePath);
    sandboxRepoDir = worktreePath;
    providerHandle = options._test!.bindMountHandle;
  } else {
    const resolvedEnv = await Effect.runPromise(
      resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
    );
    const env = mergeProviderEnv({
      resolvedEnv,
      agentProviderEnv: {},
      sandboxProviderEnv: options.sandbox.env,
    });

    const provider = options.sandbox;

    let startEffect;
    if (provider.tag === "isolated") {
      startEffect = startSandbox({
        provider,
        hostRepoDir: worktreePath,
        env,
        copyPaths: options.copyToWorktree,
      });
    } else if (provider.tag === "none") {
      startEffect = startSandbox({
        provider,
        hostRepoDir,
        env,
        worktreeOrRepoPath: worktreePath,
      });
    } else {
      startEffect = resolveGitMounts(join(hostRepoDir, ".git")).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.catchAll(() => Effect.succeed([])),
        // Patch git mounts for Windows worktree compatibility (ADR-0006)
        Effect.flatMap((gitMounts) =>
          patchGitMountsForWindows(gitMounts, worktreePath, SANDBOX_REPO_DIR),
        ),
        Effect.flatMap((gitMounts) =>
          startSandbox({
            provider,
            hostRepoDir,
            env,
            worktreeOrRepoPath: worktreePath,
            gitMounts,
            repoDir: SANDBOX_REPO_DIR,
          }),
        ),
      );
    }

    const startResult = await Effect.runPromise(startEffect);

    providerHandle = startResult.handle;
    sandbox = startResult.sandbox;
    sandboxRepoDir = startResult.worktreePath;
  }

  // 3. Run onSandboxReady hooks (sandbox-side and host-side in parallel)
  const sandboxOnReady = options.hooks?.sandbox?.onSandboxReady;
  const hostOnReady = options.hooks?.host?.onSandboxReady;

  if (sandboxOnReady?.length || hostOnReady?.length) {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandbox.exec(
          `git config --global --add safe.directory "${sandboxRepoDir}"`,
        );
        const sandboxEffects = (sandboxOnReady ?? []).map((hook) =>
          sandbox.exec(hook.command, {
            cwd: sandboxRepoDir,
            sudo: hook.sudo,
          }),
        );
        const allEffects = [...sandboxEffects] as Effect.Effect<
          unknown,
          unknown
        >[];
        if (hostOnReady?.length) {
          allEffects.push(runHostHooks(hostOnReady, worktreePath));
        }
        yield* Effect.all(allEffects, {
          concurrency: "unbounded",
        });
      }),
    );
  }

  // 4. Build applyToHost callback
  const applyToHost =
    isIsolated && providerHandle
      ? () => syncOut(worktreePath, providerHandle as IsolatedSandboxHandle)
      : () => Effect.void;

  // 5. Build and return sandbox handle — container-only close (worktree owns worktree)
  let closed = false;

  // Pre-narrow the bind-mount handle for the orchestrator's session-capture
  // path. Gating on the provider tag avoids handing a NoSandbox/Isolated
  // handle (which lack copyFileIn/copyFileOut) to AgentSessionStorage and
  // turning a missing-feature into a runtime SessionCaptureError.
  const bindMountHandle =
    options.sandbox.tag === "bind-mount"
      ? (providerHandle as BindMountSandboxHandle | undefined)
      : undefined;

  return buildSandboxHandle(
    {
      branch,
      worktreePath,
      hostRepoDir,
      sandboxRepoDir,
      sandbox,
      providerHandle,
      bindMountHandle,
      providerTag: options.sandbox.tag,
      applyToHost,
      timeouts: options.timeouts,
      branchStrategy: options.branchStrategy,
    },
    async () => {
      if (closed) return { preservedWorktreePath: undefined };
      closed = true;
      if (providerHandle) await providerHandle.close();
      return { preservedWorktreePath: undefined };
    },
  );
};

/**
 * Eagerly creates a git worktree on the provided explicit branch and starts
 * a sandbox with the worktree bind-mounted. Returns a Sandbox handle that
 * can be reused across multiple `run()` calls.
 */
export const createSandbox = async (
  options: CreateSandboxOptions,
): Promise<Sandbox> => {
  const { branch } = options;
  const isTestMode = !!options._test?.buildSandbox;
  const isIsolated = options.sandbox.tag === "isolated";

  // Resolve cwd, create the worktree, and set up the sandbox in a single Effect.
  // Once the worktree exists, any later failure (e.g. a missing image surfacing
  // when the provider creates the container) tears down the container — if it
  // started — and removes the worktree so it is not orphaned on disk.
  const { hostRepoDir, worktreePath, providerHandle, sandbox, sandboxRepoDir } =
    await Effect.runPromise(
      Effect.gen(function* () {
        const hostRepoDir = yield* resolveCwd(options.cwd);

        yield* WorktreeManager.pruneStale(hostRepoDir).pipe(
          Effect.catchAll(() => Effect.void),
        );
        const { path: worktreePath } = yield* WorktreeManager.create(
          hostRepoDir,
          { branch, baseBranch: options.baseBranch },
        );

        const prepared = yield* Effect.gen(function* () {
          // Copy files (bind-mount/no-sandbox only; isolated copies in startSandbox).
          if (
            options.copyToWorktree &&
            options.copyToWorktree.length > 0 &&
            options.sandbox.tag !== "isolated"
          ) {
            yield* copyToWorktree(
              options.copyToWorktree,
              hostRepoDir,
              worktreePath,
              options.timeouts?.copyToWorktreeMs,
            );
          }

          // Run host.onWorktreeReady hooks (after copy, before sandbox creation).
          if (options.hooks?.host?.onWorktreeReady?.length) {
            yield* runHostHooks(
              options.hooks.host.onWorktreeReady,
              worktreePath,
            );
          }

          // Start the sandbox via the test layer or the shared startSandbox helper.
          let providerHandle:
            | BindMountSandboxHandle
            | IsolatedSandboxHandle
            | NoSandboxHandle
            | undefined;
          let sandbox: SandboxService;
          let sandboxRepoDir: string;

          if (isTestMode) {
            sandbox = options._test!.buildSandbox!(worktreePath);
            sandboxRepoDir = worktreePath;
            providerHandle = options._test!.bindMountHandle;
          } else {
            const resolvedEnv = yield* resolveEnv(hostRepoDir);
            const env = mergeProviderEnv({
              resolvedEnv,
              agentProviderEnv: {},
              sandboxProviderEnv: options.sandbox.env,
            });

            const provider = options.sandbox;
            const startResult = yield* provider.tag === "isolated"
              ? startSandbox({
                  provider,
                  hostRepoDir: worktreePath,
                  env,
                  copyPaths: options.copyToWorktree,
                })
              : provider.tag === "none"
                ? startSandbox({
                    provider,
                    hostRepoDir,
                    env,
                    worktreeOrRepoPath: worktreePath,
                  })
                : resolveGitMounts(join(hostRepoDir, ".git")).pipe(
                    Effect.provide(NodeFileSystem.layer),
                    Effect.catchAll(() => Effect.succeed([])),
                    // Patch git mounts for Windows worktree compatibility (ADR-0006)
                    Effect.flatMap((gitMounts) =>
                      patchGitMountsForWindows(
                        gitMounts,
                        worktreePath,
                        SANDBOX_REPO_DIR,
                      ),
                    ),
                    Effect.flatMap((gitMounts) =>
                      startSandbox({
                        provider,
                        hostRepoDir,
                        env,
                        worktreeOrRepoPath: worktreePath,
                        gitMounts,
                        repoDir: SANDBOX_REPO_DIR,
                      }),
                    ),
                  );

            providerHandle = startResult.handle;
            sandbox = startResult.sandbox;
            sandboxRepoDir = startResult.worktreePath;
          }

          // Run onSandboxReady hooks (sandbox-side and host-side in parallel). If
          // they fail, tear down the container that just started before the outer
          // handler removes the worktree.
          const sandboxOnReady = options.hooks?.sandbox?.onSandboxReady;
          const hostOnReady = options.hooks?.host?.onSandboxReady;

          if (sandboxOnReady?.length || hostOnReady?.length) {
            yield* Effect.gen(function* () {
              yield* sandbox.exec(
                `git config --global --add safe.directory "${sandboxRepoDir}"`,
              );
              const sandboxEffects = (sandboxOnReady ?? []).map((hook) =>
                sandbox.exec(hook.command, {
                  cwd: sandboxRepoDir,
                  sudo: hook.sudo,
                }),
              );
              const allEffects = [...sandboxEffects] as Effect.Effect<
                unknown,
                unknown
              >[];
              if (hostOnReady?.length) {
                allEffects.push(runHostHooks(hostOnReady, worktreePath));
              }
              yield* Effect.all(allEffects, { concurrency: "unbounded" });
            }).pipe(
              Effect.onError(() =>
                providerHandle
                  ? Effect.promise(() =>
                      providerHandle!.close().catch(() => {}),
                    )
                  : Effect.void,
              ),
            );
          }

          return { providerHandle, sandbox, sandboxRepoDir };
        }).pipe(
          Effect.onError(() =>
            WorktreeManager.remove(worktreePath).pipe(
              Effect.catchAll(() => Effect.void),
            ),
          ),
        );

        return { hostRepoDir, worktreePath, ...prepared };
      }).pipe(Effect.provide(NodeContext.layer)),
    );

  // Build applyToHost callback (once, reused across runs)
  const applyToHost =
    isIsolated && providerHandle
      ? () => syncOut(worktreePath, providerHandle as IsolatedSandboxHandle)
      : () => Effect.void;

  let closed = false;

  const forceCleanup = () => {
    console.error(`\nWorktree preserved at ${worktreePath}`);
    console.error(`  To review: cd ${worktreePath}`);
    console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
  };

  // Route cleanup through the shared registry so concurrent sandboxes share one
  // SIGINT/SIGTERM/exit listener instead of tripping MaxListenersExceededWarning.
  const unregisterShutdown = registerShutdown(forceCleanup);

  // Build close function
  const doClose = async (): Promise<CloseResult> => {
    if (closed) return { preservedWorktreePath: undefined };
    closed = true;

    return Effect.runPromise(
      Effect.gen(function* () {
        if (providerHandle) {
          yield* Effect.promise(() => providerHandle.close());
        }

        // Preserve the worktree when it has uncommitted changes; otherwise remove it.
        const isDirty = yield* WorktreeManager.hasUncommittedChanges(
          worktreePath,
        ).pipe(Effect.catchAll(() => Effect.succeed(false)));
        if (isDirty) {
          return { preservedWorktreePath: worktreePath };
        }

        yield* WorktreeManager.remove(worktreePath).pipe(
          Effect.catchAll(() => Effect.void),
        );
        return { preservedWorktreePath: undefined };
      }),
    );
  };

  // Pre-narrow the bind-mount handle for the orchestrator's session-capture
  // path. Gating on the provider tag avoids handing a NoSandbox/Isolated
  // handle (which lack copyFileIn/copyFileOut) to AgentSessionStorage.
  const bindMountHandle =
    options.sandbox.tag === "bind-mount"
      ? (providerHandle as BindMountSandboxHandle | undefined)
      : undefined;

  // Return the Sandbox handle
  return buildSandboxHandle(
    {
      branch,
      worktreePath,
      hostRepoDir,
      sandboxRepoDir,
      sandbox,
      providerHandle,
      bindMountHandle,
      providerTag: options.sandbox.tag,
      applyToHost,
      timeouts: options.timeouts,
    },
    async () => {
      unregisterShutdown();
      return doClose();
    },
  );
};
