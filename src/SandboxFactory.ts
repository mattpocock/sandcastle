import { Context, Effect, Exit, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { join, resolve } from "node:path";
import type { PlatformError } from "@effect/platform/Error";
import {
  AgentError,
  AgentIdleTimeoutError,
  CopyError,
  ExecError,
  SyncError,
  WorktreeError,
} from "./errors.js";
import type { DockerError, SandboxError, SyncOutPathError } from "./errors.js";
import type { Timeouts } from "./run.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import { Display } from "./Display.js";
import type {
  SandboxProvider,
  BranchStrategy,
  BindMountSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import { runHostHooks } from "./SandboxLifecycle.js";
import type { SandboxHooks } from "./SandboxLifecycle.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import { patchGitMountsForWindows, removeMountTempDirs } from "./mountUtils.js";
import { registerShutdown } from "./shutdownRegistry.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      stdin?: string;
    },
  ) => Effect.Effect<ExecResult, ExecError>;

  /** Copy a file or directory from the host into the sandbox. */
  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, CopyError>;

  /** Copy a single file from the sandbox to the host. */
  readonly copyFileOut: (
    sandboxPath: string,
    hostPath: string,
  ) => Effect.Effect<void, CopyError>;
}

const getCopyIn = (
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle,
): SandboxService["copyIn"] => {
  if ("copyIn" in handle) {
    return (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: () =>
          (handle as IsolatedSandboxHandle).copyIn(hostPath, sandboxPath),
        catch: (e) =>
          new CopyError({
            message: `copyIn failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
  }
  if ("copyFileIn" in handle) {
    return (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: () =>
          (handle as BindMountSandboxHandle).copyFileIn(hostPath, sandboxPath),
        catch: (e) =>
          new CopyError({
            message: `copyFileIn failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
  }
  return () =>
    Effect.fail(
      new CopyError({
        message: "copyIn is not supported for this sandbox provider",
      }),
    );
};

/**
 * Wrap a Promise-based sandbox handle into an Effect-based SandboxService.
 * Delegates copyIn/copyFileOut to the handle when available.
 */
export const makeSandboxFromHandle = (
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle,
): SandboxService => ({
  exec: (command, options) =>
    Effect.tryPromise({
      try: () => handle.exec(command, options),
      catch: (e) =>
        new ExecError({
          command,
          message: `exec failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }),
  copyIn: getCopyIn(handle),
  copyFileOut:
    "copyFileOut" in handle
      ? (sandboxPath, hostPath) =>
          Effect.tryPromise({
            try: () =>
              (
                handle as IsolatedSandboxHandle | BindMountSandboxHandle
              ).copyFileOut(sandboxPath, hostPath),
            catch: (e) =>
              new CopyError({
                message: `copyFileOut failed: ${e instanceof Error ? e.message : String(e)}`,
              }),
          })
      : () =>
          Effect.fail(
            new CopyError({
              message: "copyFileOut is not supported for this sandbox provider",
            }),
          ),
});

/** The mount point inside the sandbox where the project worktree is bound. */
export const SANDBOX_REPO_DIR = "/home/agent/workspace";

export interface SandboxInfo {
  /** Host-side path to the worktree directory (worktree/branch mode only). */
  readonly hostWorktreePath?: string;
  /** Absolute path to the worktree inside the sandbox, as reported by the provider. */
  readonly sandboxRepoPath: string;
  /** Sync changes from the sandbox to the host worktree (isolated providers only). */
  readonly applyToHost?: () => Effect.Effect<
    void,
    SyncError | SyncOutPathError
  >;
  /** The bind-mount sandbox handle, available when the provider is a bind-mount provider. Used for session capture. */
  readonly bindMountHandle?: BindMountSandboxHandle;
}

export interface WithSandboxResult<A> {
  readonly value: A;
  /** Host path to the preserved worktree, set when the worktree was left behind due to uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

export class SandboxFactory extends Context.Tag(
  "@ai-hero/sandcastle/SandboxFactory",
)<
  SandboxFactory,
  {
    readonly withSandbox: <A, E, R>(
      makeEffect: (
        info: SandboxInfo,
        sandbox: SandboxService,
      ) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<WithSandboxResult<A>, E | SandboxError, R>;
  }
>() {}

/**
 * A SandboxFactory layer that hands every caller the same, already-started
 * sandbox, instead of creating one per call. Used by the `run()` methods of
 * `createSandbox` and `createWorktree` handles.
 */
export const reuseSandboxFactoryLayer = (
  info: SandboxInfo,
  sandbox: SandboxService,
): Layer.Layer<SandboxFactory> =>
  Layer.succeed(SandboxFactory, {
    withSandbox: <A, E, R>(
      makeEffect: (
        info: SandboxInfo,
        sandbox: SandboxService,
      ) => Effect.Effect<A, E, R>,
    ): Effect.Effect<WithSandboxResult<A>, E, R> =>
      makeEffect(info, sandbox).pipe(
        Effect.map((value) => ({ value, preservedWorktreePath: undefined })),
      ),
  });

export class SandboxConfig extends Context.Tag(
  "@ai-hero/sandcastle/SandboxFactory/SandboxConfig",
)<
  SandboxConfig,
  {
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
    readonly copyToWorktree?: string[];
    /** When specified, the run name is included in the auto-generated branch and worktree names. */
    readonly name?: string;
    /**
     * merge-to-head only: the temp branch name the caller already generated and
     * showed to the user (log filename, banner, `{{SOURCE_BRANCH}}`). The
     * worktree is created on exactly this branch instead of a fresh one.
     */
    readonly tempBranch?: string;
    /** Sandbox provider — delegates sandbox lifecycle to the provider. */
    readonly sandboxProvider: SandboxProvider;
    /** Branch strategy — controls how the agent's changes relate to branches. */
    readonly branchStrategy: BranchStrategy;
    /** Lifecycle hooks grouped by execution location (host or sandbox). */
    readonly hooks?: SandboxHooks;
    /** AbortSignal threaded to lifecycle hooks so they can cooperatively cancel. */
    readonly signal?: AbortSignal;
    /** Override default timeouts for built-in lifecycle steps. */
    readonly timeouts?: Timeouts;
  }
>() {}

/**
 * Print a message to stderr about a preserved worktree, with review and cleanup instructions.
 */
const printWorktreePreservedMessage = (
  worktreePath: string,
  reason: string,
): void => {
  console.error(`\n${reason}`);
  console.error(`  To review: cd ${worktreePath}`);
  console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
};

/**
 * After a merge-to-head worktree is removed, delete its temp branch unless it
 * holds commits found on no other branch. Those are kept (with a message on
 * how to merge or discard them) so a failed run never loses an agent's work.
 */
const cleanupTempBranch = (
  hostRepoDir: string,
  tempBranch: string,
): Effect.Effect<void> =>
  WorktreeManager.deleteTempBranchIfUnused(hostRepoDir, tempBranch).pipe(
    Effect.tap(({ unmergedCommits }) =>
      Effect.sync(() => {
        if (unmergedCommits === 0) {
          return;
        }
        const s = unmergedCommits === 1 ? "" : "s";
        console.error(
          `\nTemporary branch '${tempBranch}' kept: it has ${unmergedCommits} commit${s} not on any other branch.`,
        );
        console.error(`  To merge: git merge ${tempBranch}`);
        console.error(`  To discard: git branch -D ${tempBranch}`);
      }),
    ),
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  );

/**
 * Check for uncommitted changes and either preserve or remove the worktree.
 * Returns the preserved path if preserved, undefined if removed.
 *
 * `tempBranch` is set for merge-to-head: once the worktree is removed, the
 * temp branch is deleted too unless it holds unmerged commits.
 */
const cleanupWorktree = (
  worktreePath: string,
  exit: Exit.Exit<unknown, unknown>,
  signal: AbortSignal | undefined,
  temp?: { readonly hostRepoDir: string; readonly branch: string },
): Effect.Effect<string | undefined, WorktreeError> => {
  // An interrupted run keeps its worktree, clean or dirty, so the caller can
  // inspect it (ADR-0004). An abort after a successful run is a no-op.
  if (!Exit.isSuccess(exit) && signal?.aborted) {
    printWorktreePreservedMessage(
      worktreePath,
      `Worktree preserved at ${worktreePath}`,
    );
    return Effect.succeed(worktreePath);
  }
  return WorktreeManager.hasUncommittedChanges(worktreePath).pipe(
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.flatMap((isDirty) => {
      if (isDirty) {
        printWorktreePreservedMessage(
          worktreePath,
          Exit.isSuccess(exit)
            ? `Run succeeded but worktree has uncommitted changes at ${worktreePath}`
            : `Worktree preserved at ${worktreePath}`,
        );
        return Effect.succeed(worktreePath as string | undefined);
      }
      if (!Exit.isSuccess(exit)) {
        console.error(`\nWorktree removed (no uncommitted changes)`);
      }
      return WorktreeManager.remove(worktreePath).pipe(
        Effect.andThen(
          temp ? cleanupTempBranch(temp.hostRepoDir, temp.branch) : Effect.void,
        ),
        Effect.map(() => undefined as string | undefined),
      );
    }),
  );
};

/**
 * Attach the preserved worktree path to AgentIdleTimeoutError and AgentError so
 * programmatic callers can build on top of the preserved worktree.
 */
const attachPreservedPath = <E>(
  path: string | undefined,
  e: E | SandboxError,
): E | SandboxError => {
  if (path !== undefined) {
    if (e instanceof AgentIdleTimeoutError) {
      return new AgentIdleTimeoutError({
        message: e.message,
        timeoutMs: e.timeoutMs,
        preservedWorktreePath: path,
      });
    }
    if (e instanceof AgentError) {
      return new AgentError({
        message: e.message,
        preservedWorktreePath: path,
      });
    }
  }
  return e;
};

/** A git mount for a bind-mount sandbox. */
export interface MountEntry {
  readonly hostPath: string;
  readonly sandboxPath: string;
  /** Mount read-only. */
  readonly readonly?: boolean;
  /** A temp dir holding `hostPath`, removed when the sandbox closes. */
  readonly tempDir?: string;
}

/**
 * Resolves the git-related mounts needed for the sandbox.
 * Handles both normal repos (where .git is a directory) and worktrees
 * (where .git is a file pointing to the parent repo's .git/worktrees/<name>).
 */
export const resolveGitMounts = (
  gitPath: string,
): Effect.Effect<MountEntry[], PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(gitPath);
    if (stat.type === "Directory") {
      return [{ hostPath: gitPath, sandboxPath: gitPath }];
    }
    // Worktree: .git is a file with "gitdir: <path>"
    const content = (yield* fs.readFileString(gitPath)).trim();
    const gitdirPath = /^gitdir:\s*(.+)$/.exec(content)?.[1];
    if (gitdirPath === undefined) {
      // Unrecognized format — fall back to mounting the file as-is
      return [{ hostPath: gitPath, sandboxPath: gitPath }];
    }
    // gitdirPath is like /path/to/repo/.git/worktrees/<name>
    // Mount both the .git file and the parent .git directory
    const parentGitDir = resolve(gitdirPath, "..", "..");
    return [
      { hostPath: gitPath, sandboxPath: gitPath },
      { hostPath: parentGitDir, sandboxPath: parentGitDir },
    ];
  });

export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const {
        env,
        hostRepoDir,
        copyToWorktree: copyPaths,
        name,
        tempBranch,
        sandboxProvider,
        branchStrategy,
        hooks,
        signal,
        timeouts,
      } = yield* SandboxConfig;

      const isHeadMode = branchStrategy.type === "head";
      const branch =
        branchStrategy.type === "branch" ? branchStrategy.branch : undefined;
      const baseBranch =
        branchStrategy.type === "branch"
          ? branchStrategy.baseBranch
          : undefined;
      const fileSystem = yield* FileSystem.FileSystem;
      const display = yield* Display;

      /** merge-to-head only: the temp branch to delete with the worktree. */
      const tempBranchOf = (worktreeInfo: { readonly branch: string }) =>
        branch === undefined
          ? { hostRepoDir, branch: worktreeInfo.branch }
          : undefined;

      /** Prune stale worktrees (best-effort), then create a fresh one. */
      const pruneAndCreate = () =>
        WorktreeManager.pruneStale(hostRepoDir).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => {
              console.error(
                "[sandcastle] Warning: failed to prune stale worktrees:",
                e.message,
              );
            }),
          ),
          Effect.andThen(
            branch
              ? WorktreeManager.create(hostRepoDir, { branch, baseBranch })
              : WorktreeManager.create(hostRepoDir, { name, tempBranch }),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          // A SIGINT/SIGTERM exits the process before the release below runs,
          // so the worktree stays on disk. Say where it is, as createSandbox()
          // does, instead of leaving it behind silently.
          Effect.map((info) => ({
            ...info,
            unregisterShutdown: registerShutdown(() => {
              printWorktreePreservedMessage(
                info.path,
                `Worktree preserved at ${info.path}`,
              );
            }),
          })),
        );

      /** Release: remove or preserve the worktree (see cleanupWorktree). */
      const releaseWorktree = (
        worktreeInfo: {
          path: string;
          branch: string;
          unregisterShutdown: () => void;
        },
        exit: Exit.Exit<unknown, unknown>,
      ) =>
        Effect.sync(worktreeInfo.unregisterShutdown).pipe(
          Effect.andThen(
            cleanupWorktree(
              worktreeInfo.path,
              exit,
              signal,
              tempBranchOf(worktreeInfo),
            ),
          ),
        );

      return {
        withSandbox: <A, E, R>(
          makeEffect: (
            info: SandboxInfo,
            sandbox: SandboxService,
          ) => Effect.Effect<A, E, R>,
        ): Effect.Effect<WithSandboxResult<A>, E | SandboxError, R> => {
          // No-sandbox providers: run directly on the host, no container or mounts.
          if (sandboxProvider.tag === "none") {
            let preservedPath: string | undefined;

            // Head mode: use hostRepoDir directly, no worktree.
            if (isHeadMode) {
              return (
                hooks?.host?.onWorktreeReady?.length
                  ? runHostHooks(
                      hooks.host.onWorktreeReady,
                      hostRepoDir,
                      signal,
                    )
                  : Effect.void
              ).pipe(
                Effect.andThen(
                  Effect.acquireUseRelease(
                    startSandbox({
                      provider: sandboxProvider,
                      hostRepoDir,
                      env,
                      worktreeOrRepoPath: hostRepoDir,
                    }),
                    ({ sandbox, worktreePath }) =>
                      makeEffect(
                        {
                          hostWorktreePath: hostRepoDir,
                          sandboxRepoPath: worktreePath,
                        },
                        sandbox,
                      ) as Effect.Effect<A, E | SandboxError, R>,
                    ({ handle }) =>
                      Effect.tryPromise({
                        try: () => handle.close(),
                        catch: () => undefined,
                      }).pipe(Effect.orDie),
                  ).pipe(
                    Effect.map((value) => ({
                      value,
                      preservedWorktreePath: undefined,
                    })),
                  ),
                ),
              );
            }

            // Worktree mode (merge-to-head or explicit branch).
            // Nested so the worktree is always cleaned up (outer release) even
            // when copying, hooks, or sandbox start fail. The provider handle is
            // closed by the inner release, which only runs once it exists.
            return Effect.acquireUseRelease(
              pruneAndCreate(),
              (worktreeInfo) =>
                (copyPaths && copyPaths.length > 0
                  ? display.spinner(
                      "Copying to worktree",
                      copyToWorktree(
                        copyPaths,
                        hostRepoDir,
                        worktreeInfo.path,
                        timeouts?.copyToWorktreeMs,
                      ),
                    )
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    hooks?.host?.onWorktreeReady?.length
                      ? runHostHooks(
                          hooks.host.onWorktreeReady,
                          worktreeInfo.path,
                          signal,
                        )
                      : Effect.void,
                  ),
                  Effect.andThen(
                    Effect.acquireUseRelease(
                      startSandbox({
                        provider: sandboxProvider,
                        hostRepoDir,
                        env,
                        worktreeOrRepoPath: worktreeInfo.path,
                      }),
                      ({ sandbox, worktreePath }) =>
                        makeEffect(
                          {
                            hostWorktreePath: worktreeInfo.path,
                            sandboxRepoPath: worktreePath,
                          },
                          sandbox,
                        ),
                      ({ handle }) =>
                        Effect.tryPromise({
                          try: () => handle.close(),
                          catch: () => undefined,
                        }).pipe(Effect.orDie),
                    ),
                  ),
                ) as Effect.Effect<A, E | SandboxError, R>,
              (worktreeInfo, exit) =>
                releaseWorktree(worktreeInfo, exit).pipe(
                  Effect.tap((p) => {
                    preservedPath = p;
                  }),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            ).pipe(
              Effect.map((value) => ({
                value,
                preservedWorktreePath: preservedPath,
              })),
              Effect.mapError((e: E | SandboxError) =>
                attachPreservedPath(preservedPath, e),
              ),
            );
          }

          // Isolated providers: create worktree, sync via git bundle
          if (sandboxProvider.tag === "isolated") {
            let preservedPath: string | undefined;

            // Nested so the worktree is always cleaned up (outer release) even
            // when hooks or sandbox start fail. The provider handle is closed by
            // the inner release, which only runs once it exists.
            return Effect.acquireUseRelease(
              pruneAndCreate(),
              (worktreeInfo) =>
                (hooks?.host?.onWorktreeReady?.length
                  ? runHostHooks(
                      hooks.host.onWorktreeReady,
                      worktreeInfo.path,
                      signal,
                    )
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    Effect.acquireUseRelease(
                      startSandbox({
                        provider: sandboxProvider,
                        hostRepoDir: worktreeInfo.path,
                        env,
                        copyPaths,
                        copySourceDir: hostRepoDir,
                      }),
                      ({ sandbox, worktreePath, handle }) =>
                        makeEffect(
                          {
                            hostWorktreePath: worktreeInfo.path,
                            sandboxRepoPath: worktreePath,
                            applyToHost: () =>
                              syncOut(
                                worktreeInfo.path,
                                handle as IsolatedSandboxHandle,
                              ),
                          },
                          sandbox,
                        ),
                      ({ handle }) =>
                        Effect.tryPromise({
                          try: () => handle.close(),
                          catch: () => undefined,
                        }).pipe(Effect.orDie),
                    ),
                  ),
                ) as Effect.Effect<A, E | SandboxError, R>,
              (worktreeInfo, exit) =>
                releaseWorktree(worktreeInfo, exit).pipe(
                  Effect.tap((p) => {
                    preservedPath = p;
                  }),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            ).pipe(
              Effect.map((value) => ({
                value,
                preservedWorktreePath: preservedPath,
              })),
              Effect.mapError((e: E | SandboxError) =>
                attachPreservedPath(preservedPath, e),
              ),
            );
          }

          if (isHeadMode) {
            // Head mode: bind-mount host directory directly, no worktree
            const gitPath = join(hostRepoDir, ".git");
            return (
              hooks?.host?.onWorktreeReady?.length
                ? runHostHooks(hooks.host.onWorktreeReady, hostRepoDir, signal)
                : Effect.void
            ).pipe(
              Effect.andThen(resolveGitMounts(gitPath)),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.mapError(
                (e) =>
                  new WorktreeError({
                    message: `Failed to resolve git mounts: ${String(e)}`,
                  }) as E | SandboxError,
              ),
              Effect.flatMap((gitMounts) =>
                // Patch git mounts for Windows worktree compatibility (ADR-0006)
                patchGitMountsForWindows(
                  gitMounts,
                  hostRepoDir,
                  SANDBOX_REPO_DIR,
                ),
              ),
              Effect.flatMap((gitMounts) =>
                Effect.acquireUseRelease(
                  startSandbox({
                    provider: sandboxProvider,
                    hostRepoDir,
                    env,
                    worktreeOrRepoPath: hostRepoDir,
                    gitMounts,
                    repoDir: SANDBOX_REPO_DIR,
                  }),
                  // Use
                  ({ sandbox, worktreePath, handle }) =>
                    makeEffect(
                      {
                        hostWorktreePath: hostRepoDir,
                        sandboxRepoPath: worktreePath,
                        bindMountHandle: handle as BindMountSandboxHandle,
                      },
                      sandbox,
                    ) as Effect.Effect<A, E | SandboxError, R>,
                  // Release
                  ({ handle }) =>
                    Effect.tryPromise({
                      try: () => handle.close(),
                      catch: () => undefined,
                    }).pipe(Effect.orDie),
                ).pipe(
                  Effect.ensuring(removeMountTempDirs(gitMounts)),
                  Effect.map((value) => ({
                    value,
                    preservedWorktreePath: undefined,
                  })),
                ),
              ),
            );
          }

          // Worktree mode (merge-to-head or explicit branch)
          // Populated by the release phase when a worktree is preserved on failure,
          // so we can attach the path to recognized error types before they propagate.
          let preservedWorktreePath: string | undefined;

          // Worktree creation and sandbox start are nested so the worktree is
          // always cleaned up (outer release) even when a later step — copying,
          // hooks, or sandbox start — fails. The provider handle is closed by the
          // inner release, which only runs once the handle exists.
          return Effect.acquireUseRelease(
            // Acquire: prune stale worktrees (best-effort), then create the worktree.
            pruneAndCreate(),
            // Use: copy files, run host hooks, resolve+patch git mounts, then start
            // the sandbox under a nested acquireUseRelease.
            (worktreeInfo) =>
              (copyPaths && copyPaths.length > 0
                ? display.spinner(
                    "Copying to worktree",
                    copyToWorktree(
                      copyPaths,
                      hostRepoDir,
                      worktreeInfo.path,
                      timeouts?.copyToWorktreeMs,
                    ),
                  )
                : Effect.void
              ).pipe(
                Effect.andThen(
                  hooks?.host?.onWorktreeReady?.length
                    ? runHostHooks(
                        hooks.host.onWorktreeReady,
                        worktreeInfo.path,
                        signal,
                      )
                    : Effect.void,
                ),
                Effect.andThen(
                  resolveGitMounts(join(hostRepoDir, ".git")).pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.mapError(
                      (e) =>
                        new WorktreeError({
                          message: `Failed to resolve git mounts: ${String(e)}`,
                        }),
                    ),
                  ),
                ),
                // Patch git mounts for Windows worktree compatibility (ADR-0006)
                Effect.flatMap((gitMounts) =>
                  patchGitMountsForWindows(
                    gitMounts,
                    worktreeInfo.path,
                    SANDBOX_REPO_DIR,
                  ),
                ),
                Effect.flatMap((gitMounts) =>
                  Effect.acquireUseRelease(
                    // sandboxProvider is guaranteed bind-mount here
                    // (isolated providers return early above)
                    startSandbox({
                      provider: sandboxProvider as BindMountSandboxProvider,
                      hostRepoDir,
                      env,
                      worktreeOrRepoPath: worktreeInfo.path,
                      gitMounts,
                      repoDir: SANDBOX_REPO_DIR,
                    }),
                    ({ sandbox, worktreePath, handle }) =>
                      makeEffect(
                        {
                          hostWorktreePath: worktreeInfo.path,
                          sandboxRepoPath: worktreePath,
                          bindMountHandle: handle as BindMountSandboxHandle,
                        },
                        sandbox,
                      ),
                    ({ handle }) =>
                      Effect.tryPromise({
                        try: () => handle.close(),
                        catch: () => undefined,
                      }).pipe(Effect.orDie),
                  ).pipe(Effect.ensuring(removeMountTempDirs(gitMounts))),
                ),
              ) as Effect.Effect<A, E | SandboxError, R>,
            // Release: remove or preserve the worktree based on dirty state.
            (worktreeInfo, exit) =>
              releaseWorktree(worktreeInfo, exit).pipe(
                Effect.tap((p) => {
                  preservedWorktreePath = p;
                }),
                Effect.asVoid,
                Effect.orDie,
              ),
          ).pipe(
            Effect.map((value) => ({
              value,
              preservedWorktreePath,
            })),
            Effect.mapError((e: E | SandboxError) =>
              attachPreservedPath(preservedWorktreePath, e),
            ),
          );
        },
      };
    }),
  ),
};
