import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { join } from "node:path";
import { assertInteractiveSupported } from "./nativeSandboxProvider.js";
import * as clack from "@clack/prompts";
import { Effect, Layer } from "effect";
import type { AgentProvider } from "./AgentProvider.js";
import { ClackDisplay, Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { resolvePrompt } from "./PromptResolver.js";
import {
  makeSandboxFromHandle,
  resolveGitMounts,
  SANDBOX_REPO_DIR,
} from "./SandboxFactory.js";
import type { MountEntry } from "./SandboxFactory.js";
import { patchGitMountsForWindows, removeMountTempDirs } from "./mountUtils.js";
import { withSandboxLifecycle, runHostHooks } from "./SandboxLifecycle.js";
import type { SandboxHooks } from "./SandboxLifecycle.js";
import type {
  SandboxProvider,
  BranchStrategy,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import { resolveEnv } from "./EnvResolver.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { generateTempBranchName, getCurrentBranch } from "./WorktreeManager.js";
import {
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
  validateNoBuiltInArgOverride,
  findMissingPromptArgKeys,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import type { PromptArgs } from "./PromptArgumentSubstitution.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import { raceAbortSignal } from "./raceAbortSignal.js";
import { resolveCwd } from "./resolveCwd.js";
import type { Timeouts } from "./run.js";
import { validateTimeoutOptions } from "./validateTimeouts.js";

export interface InteractiveOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-8")) */
  readonly agent: AgentProvider;
  /** Sandbox provider (e.g. docker(), noSandbox()). */
  readonly sandbox?: SandboxProvider;
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

export interface InteractiveResult {
  /** List of commits made during the interactive session. */
  readonly commits: { sha: string }[];
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
export const interactive = async (
  options: InteractiveOptions,
): Promise<InteractiveResult> => {
  // If signal is already aborted, reject immediately without any setup
  options.signal?.throwIfAborted();

  const { prompt, promptFile, hooks, agent: provider } = options;

  validateTimeoutOptions(options);

  const resolvedSandbox = options.sandbox ?? noSandbox();
  assertInteractiveSupported(resolvedSandbox);

  // Derive branch strategy
  const branchStrategy: BranchStrategy =
    options.branchStrategy ??
    (resolvedSandbox.tag === "isolated"
      ? { type: "merge-to-head" }
      : { type: "head" }); // "bind-mount" and "none" both default to head

  // Validate: head strategy is not supported with isolated providers
  if (branchStrategy.type === "head" && resolvedSandbox.tag === "isolated") {
    throw new Error(
      "head branch strategy is not supported with isolated providers",
    );
  }

  // Validate: copyToWorktree is incompatible with head strategy
  if (
    branchStrategy.type === "head" &&
    options.copyToWorktree &&
    options.copyToWorktree.length > 0
  ) {
    throw new Error(
      "copyToWorktree is not supported with head branch strategy. " +
        "In head mode the host working directory is bind-mounted directly.",
    );
  }

  // Validate buildInteractiveArgs is available
  const buildInteractiveArgs = provider.buildInteractiveArgs?.bind(provider);
  if (!buildInteractiveArgs) {
    throw new Error(
      `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
    );
  }

  const branch: string | undefined =
    branchStrategy.type === "branch" ? branchStrategy.branch : undefined;

  const isHeadMode = branchStrategy.type === "head";
  const sandboxProvider = resolvedSandbox;

  const inner = Effect.gen(function* () {
    const hostRepoDir = yield* resolveCwd(options.cwd);
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
      sandboxProviderEnv: sandboxProvider.env,
    });
    const effectiveEnv = { ...env, ...options.env };

    // 3. Capture host's current branch
    const currentHostBranch = yield* getCurrentBranch(hostRepoDir);

    const resolvedBranch =
      branchStrategy.type === "head"
        ? currentHostBranch
        : (branch ?? generateTempBranchName(options.name));

    // 4. Validate prompt args and collect missing ones interactively (skip when no prompt).
    // Inline prompts pass through literally — skip scanning, substitution, and built-in args.
    let substitutedPrompt = rawPrompt;
    if (hasPromptSource && !isInlinePrompt) {
      const userArgs = options.promptArgs ?? {};
      yield* validateNoBuiltInArgOverride(userArgs);

      // Scan for missing keys and prompt the user for each one
      const missingKeys = findMissingPromptArgKeys(rawPrompt, userArgs);
      const collectedArgs: Record<string, string> = {};
      for (const key of missingKeys) {
        const value = yield* Effect.promise(async () =>
          clack.text({
            message: `Enter value for {{${key}}}`,
            validate: (v) => {
              if (!v) {
                return `A value is required for {{${key}}}`;
              }
            },
          }),
        );
        if (clack.isCancel(value)) {
          clack.cancel("Prompt arg collection cancelled.");
          return yield* Effect.fail(
            new Error("User cancelled prompt arg collection"),
          );
        }
        collectedArgs[key] = value;
      }

      const mergedUserArgs = { ...userArgs, ...collectedArgs };
      const effectiveArgs = {
        SOURCE_BRANCH: resolvedBranch,
        TARGET_BRANCH: currentHostBranch,
        ...mergedUserArgs,
      };
      const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
      substitutedPrompt = yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet,
      );
    } else if (isInlinePrompt) {
      const userArgs = options.promptArgs ?? {};
      yield* validateNoArgsWithInlinePrompt(userArgs);
    }

    // In head mode, pass the host branch so SandboxLifecycle skips the merge step.
    const lifecycleBranch = isHeadMode ? currentHostBranch : branch;

    // Display intro and summary
    yield* d.intro(options.name ?? "sandcastle interactive");
    yield* d.summary("Interactive Session", {
      Agent: options.name ?? provider.name,
      Sandbox: sandboxProvider.name,
      Branch: resolvedBranch,
    });

    // 5. Create worktree (unless head mode)
    let worktreeInfo: WorktreeManager.WorktreeInfo | undefined;

    if (!isHeadMode) {
      worktreeInfo = yield* d.taskLog("Creating worktree", () =>
        WorktreeManager.pruneStale(hostRepoDir).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.andThen(
            branch
              ? WorktreeManager.create(hostRepoDir, { branch })
              : WorktreeManager.create(hostRepoDir, {
                  name: options.name,
                  tempBranch: resolvedBranch,
                }),
          ),
        ),
      );
    }
    // Where the agent works on the host: the worktree, or the repo itself in
    // head mode (the only mode without a worktree).
    const hostWorkPath = worktreeInfo?.path ?? hostRepoDir;
    const copyPaths = options.copyToWorktree;

    // 6. Prepare the worktree and start the sandbox. If any step fails after the
    // worktree exists (copying, hooks, or sandbox start), remove the worktree so
    // it is not orphaned on disk.
    // Temp dirs behind the git mounts, removed once the sandbox is closed.
    const mountsToClean: MountEntry[] = [];
    const handle:
      | BindMountSandboxHandle
      | IsolatedSandboxHandle
      | NoSandboxHandle = yield* Effect.gen(function* () {
      if (!isHeadMode) {
        // Copy files to worktree (bind-mount and no-sandbox, non-head)
        if (
          (sandboxProvider.tag === "bind-mount" ||
            sandboxProvider.tag === "none") &&
          copyPaths &&
          copyPaths.length > 0
        ) {
          yield* d.taskLog("Copying files to worktree", () =>
            copyToWorktree(
              copyPaths,
              hostRepoDir,
              hostWorkPath,
              options.timeouts?.copyToWorktreeMs,
            ),
          );
        }

        // Run host.onWorktreeReady hooks
        if (hooks?.host?.onWorktreeReady?.length) {
          yield* runHostHooks(hooks.host.onWorktreeReady, hostWorkPath);
        }
      } else if (hooks?.host?.onWorktreeReady?.length) {
        // Head strategy: cwd is the host repo root
        yield* runHostHooks(hooks.host.onWorktreeReady, hostRepoDir);
      }

      // Start sandbox
      if (sandboxProvider.tag === "none") {
        // No-sandbox: run directly on the host, no container
        return yield* Effect.promise(async () =>
          sandboxProvider.create({
            worktreePath: hostWorkPath,
            env: effectiveEnv,
          }),
        );
      } else if (sandboxProvider.tag === "isolated") {
        const startResult = yield* d.taskLog("Starting sandbox", () =>
          startSandbox({
            provider: sandboxProvider,
            hostRepoDir: hostWorkPath,
            env: effectiveEnv,
            copyPaths: options.copyToWorktree,
            copySourceDir: hostRepoDir,
          }),
        );
        return startResult.handle;
      }
      const gitPath = join(hostRepoDir, ".git");
      const rawGitMounts = yield* resolveGitMounts(gitPath);
      const gitMounts = yield* patchGitMountsForWindows(
        rawGitMounts,
        hostWorkPath,
        SANDBOX_REPO_DIR,
      );
      mountsToClean.push(...gitMounts);
      const startResult = yield* d.taskLog("Starting sandbox", () =>
        startSandbox({
          provider: sandboxProvider,
          hostRepoDir,
          env: effectiveEnv,
          worktreeOrRepoPath: hostWorkPath,
          gitMounts,
          repoDir: SANDBOX_REPO_DIR,
        }),
      );
      return startResult.handle;
    }).pipe(
      Effect.tapError(() =>
        worktreeInfo
          ? WorktreeManager.remove(worktreeInfo.path).pipe(
              Effect.catchAll(() => Effect.void),
            )
          : Effect.void,
      ),
      Effect.onError(() => removeMountTempDirs(mountsToClean)),
    );

    // Run lifecycle with guaranteed cleanup of handle and worktree
    return yield* Effect.gen(function* () {
      // Check interactiveExec is available (no-sandbox always has it; bind-mount/isolated it's optional)
      if (!handle.interactiveExec) {
        throw new Error(
          `Sandbox provider does not support interactiveExec. ` +
            `The provider must implement the optional interactiveExec method to use interactive().`,
        );
      }
      const interactiveExecFn = handle.interactiveExec.bind(handle);

      // Build sandbox service and run withSandboxLifecycle
      const sandbox = makeSandboxFromHandle(handle);
      const { worktreePath } = handle;

      const applyToHost =
        sandboxProvider.tag === "isolated" && worktreeInfo
          ? () => syncOut(hostWorkPath, handle as IsolatedSandboxHandle)
          : () => Effect.void; // bind-mount and no-sandbox don't need sync

      const lifecycleEffect = withSandboxLifecycle(
        {
          hostRepoDir,
          sandboxRepoDir: worktreePath,
          hooks,
          branch: lifecycleBranch,
          hostWorktreePath: isHeadMode ? hostRepoDir : worktreeInfo?.path,
          applyToHost,
          timeouts: options.timeouts,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            // Preprocess prompt (expand !`command` shell expressions inside sandbox).
            // Skip when no prompt source was provided, or when inline (literal passthrough).
            const fullPrompt =
              !hasPromptSource || isInlinePrompt
                ? substitutedPrompt
                : yield* preprocessPrompt(
                    substitutedPrompt,
                    ctx.sandbox,
                    ctx.sandboxRepoDir,
                  );

            // Build interactive args and run the session
            const interactiveArgs = buildInteractiveArgs({
              prompt: fullPrompt,
              dangerouslySkipPermissions: sandboxProvider.tag !== "none",
            });

            const result = yield* raceAbortSignal(
              Effect.promise(async () =>
                interactiveExecFn(interactiveArgs, {
                  stdin: process.stdin,
                  stdout: process.stdout,
                  stderr: process.stderr,
                  cwd: worktreePath,
                }),
              ),
              options.signal,
            );

            return result.exitCode;
          }),
      );

      const lifecycleResult = yield* lifecycleEffect;

      const exitCode = lifecycleResult.result;

      // Check for uncommitted changes (worktree mode only)
      let preservedWorktreePath: string | undefined;
      if (worktreeInfo) {
        const hasUncommitted = yield* WorktreeManager.hasUncommittedChanges(
          worktreeInfo.path,
        ).pipe(Effect.catchAll(() => Effect.succeed(false)));
        if (hasUncommitted) {
          preservedWorktreePath = worktreeInfo.path;
        }
      }

      // Clean up worktree if not preserved
      if (worktreeInfo && !preservedWorktreePath) {
        yield* WorktreeManager.remove(worktreeInfo.path).pipe(
          Effect.catchAll(() => Effect.void),
        );
      }

      // Final summary
      yield* d.summary("Session Complete", {
        Commits: String(lifecycleResult.commits.length),
        Branch: lifecycleResult.branch,
        "Exit code": String(exitCode),
        ...(preservedWorktreePath
          ? { "Preserved worktree": preservedWorktreePath }
          : {}),
      });

      return {
        commits: lifecycleResult.commits,
        branch: lifecycleResult.branch,
        preservedWorktreePath,
        exitCode,
      };
    }).pipe(
      // On error, always clean up worktree (on success, handled above with preserve check)
      Effect.tapError(() =>
        worktreeInfo
          ? WorktreeManager.remove(worktreeInfo.path).pipe(
              Effect.catchAll(() => Effect.void),
            )
          : Effect.void,
      ),
      // Always close sandbox handle
      Effect.ensuring(
        Effect.promise(async () => handle.close().catch(() => {})).pipe(
          Effect.andThen(removeMountTempDirs(mountsToClean)),
        ),
      ),
    );
  });

  let result: InteractiveResult;
  try {
    result = await Effect.runPromise(
      inner.pipe(
        Effect.provide(
          Layer.mergeAll(
            ClackDisplay.layer,
            NodeContext.layer,
            NodeFileSystem.layer,
          ),
        ),
      ),
    );
  } catch (error: unknown) {
    // If the signal was aborted, surface its reason verbatim (no wrapping)
    options.signal?.throwIfAborted();
    throw error;
  }

  return result;
};
