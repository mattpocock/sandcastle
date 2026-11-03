import { Effect } from "effect";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import {
  ContainerStartTimeoutError,
  CopyToWorktreeTimeoutError,
  SyncInTimeoutError,
  WorktreeError,
  withTimeout,
} from "./errors.js";
import type { DockerError, SyncError } from "./errors.js";
import type {
  BindMountSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxProvider,
  IsolatedSandboxHandle,
  NoSandboxProvider,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import { makeSandboxFromHandle, SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import type { SandboxService, MountEntry } from "./SandboxFactory.js";
import { syncIn } from "./syncIn.js";
import { createClosingIfAbandoned } from "./createClosingIfAbandoned.js";
import { normalizeMounts } from "./mountUtils.js";
import { protectGitControlFiles } from "./protectGitMounts.js";

export interface StartSandboxBindMountOptions {
  provider: BindMountSandboxProvider;
  hostRepoDir: string;
  env: Record<string, string>;
  worktreeOrRepoPath: string;
  gitMounts: MountEntry[];
  repoDir: string;
  copyPaths?: undefined;
}

export type StartSandboxIsolatedOptions = {
  provider: IsolatedSandboxProvider;
  /** Directory synced into the sandbox via git bundle (usually the worktree). */
  hostRepoDir: string;
  env: Record<string, string>;
  worktreeOrRepoPath?: undefined;
  gitMounts?: undefined;
  repoDir?: undefined;
} & (
  | { copyPaths?: undefined; copySourceDir?: undefined }
  | {
      copyPaths: string[] | undefined;
      /**
       * Directory `copyPaths` are resolved against: the user's repo, not the
       * fresh worktree, which never contains gitignored files.
       */
      copySourceDir: string;
    }
);

export interface StartSandboxNoSandboxOptions {
  provider: NoSandboxProvider;
  hostRepoDir: string;
  env: Record<string, string>;
  /** Host-side worktree path the agent will run in. Equal to hostRepoDir in head mode. */
  worktreeOrRepoPath: string;
  gitMounts?: undefined;
  repoDir?: undefined;
  copyPaths?: undefined;
}

export type StartSandboxOptions =
  | StartSandboxBindMountOptions
  | StartSandboxIsolatedOptions
  | StartSandboxNoSandboxOptions;

/** A started sandbox; `H` narrows the handle to one provider tag's. */
export interface StartSandboxResult<
  H = BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle,
> {
  handle: H;
  sandbox: SandboxService;
  worktreePath: string;
}

export type StartSandboxError =
  | DockerError
  | WorktreeError
  | SyncError
  | ContainerStartTimeoutError
  | SyncInTimeoutError
  | CopyToWorktreeTimeoutError;

export const CONTAINER_START_TIMEOUT_MS = 120_000;
const SYNC_IN_TIMEOUT_MS = 120_000;
export const COPY_PATHS_TIMEOUT_MS = 120_000;

const toResult = <H extends StartSandboxResult["handle"]>(
  handle: H,
): StartSandboxResult<H> => ({
  handle,
  sandbox: makeSandboxFromHandle(handle),
  worktreePath: handle.worktreePath,
});

// `provider.tag` is nested, so checking it doesn't narrow `options`.
const isBindMountOptions = (
  options: StartSandboxOptions,
): options is StartSandboxBindMountOptions =>
  options.provider.tag === "bind-mount";

const isNoSandboxOptions = (
  options: StartSandboxOptions,
): options is StartSandboxNoSandboxOptions => options.provider.tag === "none";

/**
 * Start a sandbox by dispatching on `provider.tag`.
 *
 * - `"bind-mount"`: creates mounts and delegates to the provider's `create()`.
 * - `"isolated"`: creates handle, syncs host repo via git bundle, then copies
 *   optional `copyPaths` via `handle.copyIn()`.
 *
 * Returns the handle, a `SandboxService` layer, and the worktree path.
 */
export const startSandbox = (
  options: StartSandboxOptions,
): Effect.Effect<StartSandboxResult, StartSandboxError> => {
  if (isBindMountOptions(options)) {
    return startBindMountSandbox(options);
  }
  if (isNoSandboxOptions(options)) {
    return startNoSandbox(options);
  }
  return startIsolatedSandbox(options);
};

const startNoSandbox = (
  options: StartSandboxNoSandboxOptions,
): Effect.Effect<StartSandboxResult<NoSandboxHandle>, WorktreeError> =>
  Effect.tryPromise({
    try: () =>
      options.provider.create({
        worktreePath: options.worktreeOrRepoPath,
        env: options.env,
      }),
    catch: (e) =>
      new WorktreeError({
        message: `Provider '${options.provider.name}' create failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(Effect.map((handle) => toResult(handle)));

/** `startSandbox` for a bind-mount provider, typed to its handle. */
export const startBindMountSandbox = (
  options: StartSandboxBindMountOptions,
): Effect.Effect<
  StartSandboxResult<BindMountSandboxHandle>,
  DockerError | WorktreeError | ContainerStartTimeoutError
> => {
  const { worktreeOrRepoPath, provider } = options;
  const rawMounts = [
    { hostPath: worktreeOrRepoPath, sandboxPath: options.repoDir },
    ...options.gitMounts,
  ];
  // The sandbox may write the repo's objects and refs, but never the git
  // files that decide what git on the host runs.
  return protectGitControlFiles(
    normalizeMounts(rawMounts, {
      worktreeHostPath: worktreeOrRepoPath,
      sandboxRepoDir: SANDBOX_REPO_DIR,
    }),
    worktreeOrRepoPath,
  ).pipe(
    Effect.flatMap((mounts) =>
      createClosingIfAbandoned(
        () =>
          provider.create({
            worktreePath:
              process.platform === "win32"
                ? worktreeOrRepoPath.replaceAll("\\", "/")
                : worktreeOrRepoPath,
            hostRepoPath: options.hostRepoDir,
            mounts,
            env: options.env,
          }),
        (e) =>
          new WorktreeError({
            message: `Provider '${provider.name}' create failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      ),
    ),
    Effect.map((handle) => toResult(handle)),
    withTimeout(
      CONTAINER_START_TIMEOUT_MS,
      () =>
        new ContainerStartTimeoutError({
          message: `Sandbox container start timed out after ${CONTAINER_START_TIMEOUT_MS}ms`,
          timeoutMs: CONTAINER_START_TIMEOUT_MS,
        }),
    ),
  );
};

/** Copies `paths` (relative to `sourceDir`) into the sandbox's worktree. */
const copyPathsIn = (
  handle: IsolatedSandboxHandle,
  paths: string[],
  sourceDir: string,
): Effect.Effect<void, WorktreeError | CopyToWorktreeTimeoutError> =>
  Effect.gen(function* () {
    for (const relativePath of paths) {
      const hostPath = join(sourceDir, relativePath);
      if (!existsSync(hostPath)) {
        continue;
      }
      // Sandbox-side path: Linux container, must use POSIX separators
      // regardless of host platform.
      const sandboxPath = posix.join(handle.worktreePath, relativePath);
      yield* Effect.tryPromise({
        try: () => handle.copyIn(hostPath, sandboxPath),
        catch: (e) =>
          new WorktreeError({
            message: `Failed to copy ${relativePath} into sandbox: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
    }
  }).pipe(
    withTimeout(
      COPY_PATHS_TIMEOUT_MS,
      () =>
        new CopyToWorktreeTimeoutError({
          message: `Copying paths to worktree timed out after ${COPY_PATHS_TIMEOUT_MS}ms`,
          timeoutMs: COPY_PATHS_TIMEOUT_MS,
          paths,
        }),
    ),
  );

/** `startSandbox` for an isolated provider, typed to its handle. */
export const startIsolatedSandbox = (
  options: StartSandboxIsolatedOptions,
): Effect.Effect<
  StartSandboxResult<IsolatedSandboxHandle>,
  StartSandboxError
> =>
  Effect.gen(function* () {
    const handle = yield* createClosingIfAbandoned(
      () => options.provider.create({ env: options.env }),
      (e) =>
        new WorktreeError({
          message: `Isolated provider '${options.provider.name}' setup failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    ).pipe(
      withTimeout(
        CONTAINER_START_TIMEOUT_MS,
        () =>
          new ContainerStartTimeoutError({
            message: `Isolated sandbox container start timed out after ${CONTAINER_START_TIMEOUT_MS}ms`,
            timeoutMs: CONTAINER_START_TIMEOUT_MS,
          }),
      ),
    );

    // From here on the sandbox exists, but the caller only gets the handle
    // (and so can only close it) once this effect succeeds. Close it
    // ourselves on any failure, timeout or interruption, so a remote sandbox
    // never outlives a failed setup.
    yield* Effect.gen(function* () {
      yield* syncIn(options.hostRepoDir, handle).pipe(
        withTimeout(
          SYNC_IN_TIMEOUT_MS,
          () =>
            new SyncInTimeoutError({
              message: `Sync-in timed out after ${SYNC_IN_TIMEOUT_MS}ms`,
              timeoutMs: SYNC_IN_TIMEOUT_MS,
            }),
        ),
      );
      if (options.copyPaths && options.copyPaths.length > 0) {
        yield* copyPathsIn(handle, options.copyPaths, options.copySourceDir);
      }
    }).pipe(
      Effect.onError(() =>
        Effect.tryPromise(() => handle.close()).pipe(Effect.ignore),
      ),
    );

    return toResult(handle);
  });
