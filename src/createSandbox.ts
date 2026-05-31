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
} from "./SandboxProvider.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import { resolveCwd } from "./resolveCwd.js";
import { patchGitMountsForWindows } from "./mountUtils.js";
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
  };
}

export interface SandboxRunOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-7")). */
  readonly agent: AgentProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Key-value map for {{KEY}} placeholder substitution in prompts. */
  readonly promptArgs?: PromptArgs;
  /** Maximum iterations to run (default: 1). */
  readonly maxIterations?: number;
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
}

export interface SandboxInteractiveOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-7")). */
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
  /** Tear down the sandbox and worktree. */
  close(): Promise<CloseResult>;
  /** Auto teardown via `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
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
  readonly applyToHost: () => Effect.Effect<void, any>;
  readonly timeouts?: Timeouts;
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
    applyToHost,
    timeouts,
  } = ctx;

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
              bindMountHandle: providerHandle as
                | BindMountSandboxHandle
                | undefined,
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
        resolvedLogging.type === "file"
          ? resolvedLogging.onAgentStreamEvent
          : undefined,
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
              branch,
              provider,
              completionSignal: runOptions.completionSignal,
              idleTimeoutSeconds: runOptions.idleTimeoutSeconds,
              completionTimeoutSeconds: runOptions.completionTimeoutSeconds,
              name: runOptions.name,
              signal: runOptions.signal,
              skipPromptExpansion: isInlinePrompt,
              timeouts,
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

      return {
        iterations: result.iterations,
        completionSignal: result.completionSignal,
        stdout: result.stdout,
        commits: result.commits,
        logFilePath:
          resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
      };
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
                branch,
                hostWorktreePath: worktreePath,
                applyToHost,
                timeouts,
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
  readonly _test?: {
    readonly buildSandbox?: (sandboxDir: string) => SandboxService;
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
          Effect.tryPromise({
            try: () =>
              patchGitMountsForWindows(
                gitMounts,
                worktreePath,
                SANDBOX_REPO_DIR,
              ),
            catch: (e) =>
              new Error(
                `Failed to patch git mounts: ${e instanceof Error ? e.message : String(e)}`,
              ),
          }),
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

  return buildSandboxHandle(
    {
      branch,
      worktreePath,
      hostRepoDir,
      sandboxRepoDir,
      sandbox,
      providerHandle,
      applyToHost,
      timeouts: options.timeouts,
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
                      Effect.tryPromise({
                        try: () =>
                          patchGitMountsForWindows(
                            gitMounts,
                            worktreePath,
                            SANDBOX_REPO_DIR,
                          ),
                        catch: (e) =>
                          new Error(
                            `Failed to patch git mounts: ${e instanceof Error ? e.message : String(e)}`,
                          ),
                      }),
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

  // Return the Sandbox handle
  return buildSandboxHandle(
    {
      branch,
      worktreePath,
      hostRepoDir,
      sandboxRepoDir,
      sandbox,
      providerHandle,
      applyToHost,
      timeouts: options.timeouts,
    },
    async () => {
      unregisterShutdown();
      return doClose();
    },
  );
};
