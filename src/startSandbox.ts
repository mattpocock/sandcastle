import { Effect } from "effect";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import {
  ContainerStartTimeoutError,
  CopyToWorktreeTimeoutError,
  SyncError,
  SyncInTimeoutError,
  WorktreeError,
  withTimeout,
  type DockerError,
} from "./errors.js";
import type {
  SandboxProvider,
  BindMountSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxProvider,
  IsolatedSandboxHandle,
  NoSandboxProvider,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import {
  type SandboxService,
  type MountEntry,
  makeSandboxFromHandle,
  SANDBOX_REPO_DIR,
} from "./SandboxFactory.js";
import type { ResolvedSkill } from "./AgentSkills.js";
import { syncIn } from "./syncIn.js";
import { normalizeMounts } from "./mountUtils.js";

export interface StartSandboxBindMountOptions {
  provider: BindMountSandboxProvider;
  hostRepoDir: string;
  env: Record<string, string>;
  worktreeOrRepoPath: string;
  gitMounts: MountEntry[];
  repoDir: string;
  copyPaths?: undefined;
  skills?: readonly ResolvedSkill[];
}

export interface StartSandboxIsolatedOptions {
  provider: IsolatedSandboxProvider;
  hostRepoDir: string;
  env: Record<string, string>;
  worktreeOrRepoPath?: undefined;
  gitMounts?: undefined;
  repoDir?: undefined;
  copyPaths?: string[];
  skills?: readonly ResolvedSkill[];
}

export interface StartSandboxNoSandboxOptions {
  provider: NoSandboxProvider;
  hostRepoDir: string;
  env: Record<string, string>;
  /** Host-side worktree path the agent will run in. Equal to hostRepoDir in head mode. */
  worktreeOrRepoPath: string;
  gitMounts?: undefined;
  repoDir?: undefined;
  copyPaths?: undefined;
  skills?: readonly ResolvedSkill[];
}

export type StartSandboxOptions =
  | StartSandboxBindMountOptions
  | StartSandboxIsolatedOptions
  | StartSandboxNoSandboxOptions;

export interface StartSandboxResult {
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle;
  sandbox: SandboxService;
  worktreePath: string;
}

const CONTAINER_START_TIMEOUT_MS = 120_000;
const SYNC_IN_TIMEOUT_MS = 120_000;
export const COPY_PATHS_TIMEOUT_MS = 120_000;

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
): Effect.Effect<
  StartSandboxResult,
  | DockerError
  | WorktreeError
  | SyncError
  | ContainerStartTimeoutError
  | SyncInTimeoutError
  | CopyToWorktreeTimeoutError
> => {
  if (options.provider.tag === "bind-mount") {
    return startBindMountSandbox(options as StartSandboxBindMountOptions);
  }
  if (options.provider.tag === "none") {
    return startNoSandbox(options as StartSandboxNoSandboxOptions);
  }
  return startIsolatedSandbox(options as StartSandboxIsolatedOptions);
};

const startNoSandbox = (
  options: StartSandboxNoSandboxOptions,
): Effect.Effect<StartSandboxResult, WorktreeError> =>
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
  }).pipe(
    Effect.map((handle) => ({
      handle,
      sandbox: makeSandboxFromHandle(handle),
      worktreePath: handle.worktreePath,
    })),
  );

const startBindMountSandbox = (
  options: StartSandboxBindMountOptions,
): Effect.Effect<
  StartSandboxResult,
  DockerError | WorktreeError | ContainerStartTimeoutError
> =>
  Effect.tryPromise({
    try: () => {
      const rawMounts = [
        {
          hostPath: options.worktreeOrRepoPath,
          sandboxPath: options.repoDir,
        },
        ...options.gitMounts,
        ...(options.skills ?? []).map((skill) => ({
          hostPath: skill.hostPath,
          sandboxPath: skill.sandboxPath,
          readonly: skill.readonly,
        })),
      ];
      const mounts = normalizeMounts(
        rawMounts,
        options.worktreeOrRepoPath,
        SANDBOX_REPO_DIR,
      );
      const worktreePath =
        process.platform === "win32"
          ? options.worktreeOrRepoPath.replace(/\\/g, "/")
          : options.worktreeOrRepoPath;
      return options.provider.create({
        worktreePath,
        hostRepoPath: options.hostRepoDir,
        mounts,
        env: options.env,
      });
    },
    catch: (e) =>
      new WorktreeError({
        message: `Provider '${options.provider.name}' create failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(
    Effect.map((handle) => ({
      handle,
      sandbox: makeSandboxFromHandle(handle),
      worktreePath: handle.worktreePath,
    })),
    withTimeout(
      CONTAINER_START_TIMEOUT_MS,
      () =>
        new ContainerStartTimeoutError({
          message: `Sandbox container start timed out after ${CONTAINER_START_TIMEOUT_MS}ms`,
          timeoutMs: CONTAINER_START_TIMEOUT_MS,
        }),
    ),
  );

const closeIsolatedHandle = (handle: IsolatedSandboxHandle) =>
  Effect.tryPromise({
    try: () => handle.close(),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void));

const startIsolatedSandbox = (
  options: StartSandboxIsolatedOptions,
): Effect.Effect<
  StartSandboxResult,
  | DockerError
  | WorktreeError
  | SyncError
  | ContainerStartTimeoutError
  | SyncInTimeoutError
  | CopyToWorktreeTimeoutError
> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => options.provider.create({ env: options.env }),
      catch: (e) =>
        new WorktreeError({
          message: `Isolated provider '${options.provider.name}' setup failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }).pipe(
      withTimeout(
        CONTAINER_START_TIMEOUT_MS,
        () =>
          new ContainerStartTimeoutError({
            message: `Isolated sandbox container start timed out after ${CONTAINER_START_TIMEOUT_MS}ms`,
            timeoutMs: CONTAINER_START_TIMEOUT_MS,
          }),
      ),
    ),
    (handle) =>
      Effect.gen(function* () {
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
          const pathsToCopy = options.copyPaths;
          yield* Effect.gen(function* () {
            for (const relativePath of pathsToCopy) {
              const hostPath = join(options.hostRepoDir, relativePath);
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
                  paths: pathsToCopy,
                }),
            ),
          );
        }

        if (options.skills && options.skills.length > 0) {
          const skillsToCopy = options.skills;
          yield* Effect.gen(function* () {
            for (const skill of skillsToCopy) {
              yield* Effect.tryPromise({
                try: () => handle.copyIn(skill.hostPath, skill.sandboxPath),
                catch: (e) =>
                  new WorktreeError({
                    message: `Failed to copy skill ${skill.name} into sandbox: ${e instanceof Error ? e.message : String(e)}`,
                  }),
              });
            }
          }).pipe(
            withTimeout(
              COPY_PATHS_TIMEOUT_MS,
              () =>
                new CopyToWorktreeTimeoutError({
                  message: `Copying skills into sandbox timed out after ${COPY_PATHS_TIMEOUT_MS}ms`,
                  timeoutMs: COPY_PATHS_TIMEOUT_MS,
                  paths: skillsToCopy.map((skill) => skill.name),
                }),
            ),
          );
        }

        return {
          handle,
          sandbox: makeSandboxFromHandle(handle),
          worktreePath: handle.worktreePath,
        };
      }),
    (handle, exit) => {
      if (exit._tag === "Success") {
        return Effect.void;
      }
      return closeIsolatedHandle(handle);
    },
  );
