import { Context, Effect, Exit, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";

import { createInterface } from "node:readline";
import {
  startContainer,
  removeContainer,
  chownInContainer,
} from "./DockerLifecycle.js";
import {
  AgentError,
  CopyError,
  ExecError,
  TimeoutError,
  type DockerError,
  type WorktreeError,
} from "./errors.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToSandbox } from "./CopyToSandbox.js";
import { Display } from "./Display.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: { cwd?: string },
  ) => Effect.Effect<ExecResult, ExecError>;

  readonly execStreaming: (
    command: string,
    onStdoutLine: (line: string) => void,
    options?: { cwd?: string },
  ) => Effect.Effect<ExecResult, ExecError>;

  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, CopyError>;

  readonly copyOut: (
    sandboxPath: string,
    hostPath: string,
  ) => Effect.Effect<void, CopyError>;
}

export class Sandbox extends Context.Tag("Sandbox")<
  Sandbox,
  SandboxService
>() {}

const makeDockerSandbox = (
  containerName: string,
): Effect.Effect<SandboxService, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      exec: (command, options) =>
        Effect.async((resume) => {
          const args = ["exec"];
          if (options?.cwd) {
            args.push("-w", options.cwd);
          }
          args.push(containerName, "sh", "-c", command);

          execFile(
            "docker",
            args,
            { maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
              if (error && error.code === undefined) {
                resume(
                  Effect.fail(
                    new ExecError({
                      command,
                      message: `docker exec failed: ${error.message}`,
                    }),
                  ),
                );
              } else {
                resume(
                  Effect.succeed({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode:
                      typeof error?.code === "number"
                        ? error.code
                        : (0 as number),
                  }),
                );
              }
            },
          );
        }),

      execStreaming: (command, onStdoutLine, options) =>
        Effect.async((resume) => {
          const args = ["exec"];
          if (options?.cwd) {
            args.push("-w", options.cwd);
          }
          args.push(containerName, "sh", "-c", command);

          const proc = spawn("docker", args, {
            stdio: ["ignore", "pipe", "pipe"],
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];

          const rl = createInterface({ input: proc.stdout! });
          rl.on("line", (line) => {
            stdoutChunks.push(line);
            onStdoutLine(line);
          });

          proc.stderr!.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });

          proc.on("error", (error) => {
            resume(
              Effect.fail(
                new ExecError({
                  command,
                  message: `docker exec streaming failed: ${error.message}`,
                }),
              ),
            );
          });

          proc.on("close", (code) => {
            resume(
              Effect.succeed({
                stdout: stdoutChunks.join("\n"),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              }),
            );
          });
        }),

      copyIn: (hostPath, sandboxPath) =>
        Effect.gen(function* () {
          const parentDir = dirname(sandboxPath);
          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["exec", containerName, "mkdir", "-p", parentDir],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to create dir ${parentDir}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });

          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["cp", hostPath, `${containerName}:${sandboxPath}`],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to copy ${hostPath} -> ${containerName}:${sandboxPath}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });
        }),

      copyOut: (sandboxPath, hostPath) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dirname(hostPath), { recursive: true }).pipe(
            Effect.mapError(
              (error) =>
                new CopyError({
                  message: `Failed to create host dir ${dirname(hostPath)}: ${error}`,
                }),
            ),
          );

          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["cp", `${containerName}:${sandboxPath}`, hostPath],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to copy ${containerName}:${sandboxPath} -> ${hostPath}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });
        }),
    };
  });

export const makeDockerSandboxLayer = (
  containerName: string,
): Layer.Layer<Sandbox> =>
  Layer.effect(Sandbox, makeDockerSandbox(containerName)).pipe(
    Layer.provide(NodeFileSystem.layer),
  );

/** The mount point inside the container where the project worktree is bound. */
export const SANDBOX_WORKSPACE_DIR = "/home/agent/workspace";

export interface SandboxInfo {
  /** Host-side path to the worktree directory (worktree mode only). */
  readonly hostWorktreePath?: string;
}

export interface WithSandboxResult<A> {
  readonly value: A;
  /** Host path to the preserved worktree, set when the worktree was left behind due to uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

export class SandboxFactory extends Context.Tag("SandboxFactory")<
  SandboxFactory,
  {
    readonly withSandbox: <A, E, R>(
      makeEffect: (info: SandboxInfo) => Effect.Effect<A, E, R | Sandbox>,
    ) => Effect.Effect<
      WithSandboxResult<A>,
      E | DockerError | WorktreeError,
      Exclude<R, Sandbox>
    >;
  }
>() {}

/**
 * Synchronously force-remove a Docker container.
 * Used in process exit handlers where async operations are not possible.
 */
const forceRemoveContainerSync = (containerName: string): void => {
  try {
    execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
  } catch {
    // Best-effort — container may already be gone
  }
};

export class WorktreeSandboxConfig extends Context.Tag("WorktreeSandboxConfig")<
  WorktreeSandboxConfig,
  {
    readonly imageName: string;
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** Worktree mode: none, temp-branch (default), or explicit branch. */
    readonly worktree?: import("./run.js").WorktreeMode;
    /** Paths relative to the host repo root to copy into the worktree before container start. */
    readonly copyToSandbox?: string[];
    /** When specified, the run name is included in the auto-generated branch and worktree names. */
    readonly name?: string;
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
 * Start a Docker container with the given volume mounts and return cleanup helpers.
 * Shared between worktree and none modes.
 */
const startSandboxContainer = (
  containerName: string,
  imageName: string,
  env: Record<string, string>,
  volumeMounts: string[],
) => {
  const cleanupContainerOnly = () => {
    forceRemoveContainerSync(containerName);
  };
  const onSignal = () => {
    cleanupContainerOnly();
    process.exit(1);
  };

  const hostUid = process.getuid?.() ?? 1000;
  const hostGid = process.getgid?.() ?? 1000;

  // OAuth auth is handled via CLAUDE_CODE_OAUTH_TOKEN env var
  // (passed through .sandcastle/.env → container env).
  // No ~/.claude mount needed.
  const allMounts = volumeMounts;

  return startContainer(
    containerName,
    imageName,
    { ...env, HOME: "/home/agent" },
    {
      volumeMounts: allMounts,
      workdir: SANDBOX_WORKSPACE_DIR,
      user: `${hostUid}:${hostGid}`,
    },
  ).pipe(
    Effect.andThen(
      chownInContainer(containerName, `${hostUid}:${hostGid}`, "/home/agent"),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        process.on("exit", cleanupContainerOnly);
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
      }),
    ),
    Effect.map(() => ({ cleanupContainerOnly, onSignal })),
  );
};

/**
 * Worktree sandbox mode: creates a git worktree and bind-mounts it into the
 * container at SANDBOX_WORKSPACE_DIR. The host's .git directory is also bind-mounted at
 * its original host path so the worktree's .git file pointer resolves correctly.
 *
 * In 'none' mode: bind-mounts the host's working directory directly into the container.
 * No worktree is created, pruned, or cleaned up.
 */
export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const {
        imageName,
        env,
        hostRepoDir,
        worktree: worktreeMode,
        copyToSandbox: copyPaths,
        name,
      } = yield* WorktreeSandboxConfig;
      const isNoneMode = worktreeMode?.mode === "none";
      const branch =
        worktreeMode?.mode === "branch" ? worktreeMode.branch : undefined;
      const fileSystem = yield* FileSystem.FileSystem;
      const display = yield* Display;
      return {
        withSandbox: <A, E, R>(
          makeEffect: (info: SandboxInfo) => Effect.Effect<A, E, R | Sandbox>,
        ): Effect.Effect<
          WithSandboxResult<A>,
          E | DockerError | WorktreeError,
          Exclude<R, Sandbox>
        > => {
          const containerName = `sandcastle-${randomUUID()}`;

          if (isNoneMode) {
            // None mode: bind-mount host directory directly, no worktree
            const gitDir = join(hostRepoDir, ".git");
            const volumeMounts = [
              `${hostRepoDir}:${SANDBOX_WORKSPACE_DIR}`,
              `${gitDir}:${gitDir}`,
            ];
            return Effect.acquireUseRelease(
              startSandboxContainer(
                containerName,
                imageName,
                env,
                volumeMounts,
              ),
              // Use
              () =>
                makeEffect({}).pipe(
                  Effect.provide(makeDockerSandboxLayer(containerName)),
                ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
              // Release: remove container only (no worktree to clean up)
              ({ cleanupContainerOnly, onSignal }) =>
                Effect.sync(() => {
                  process.removeListener("exit", cleanupContainerOnly);
                  process.removeListener("SIGINT", onSignal);
                  process.removeListener("SIGTERM", onSignal);
                }).pipe(
                  Effect.andThen(removeContainer(containerName)),
                  Effect.orDie,
                ),
            ).pipe(
              Effect.map((value) => ({
                value,
                preservedWorktreePath: undefined,
              })),
            );
          }

          // Worktree mode (temp-branch or explicit branch)
          // Populated by the release phase when a worktree is preserved on failure,
          // so we can attach the path to recognized error types before they propagate.
          let preservedWorktreePath: string | undefined;

          return Effect.acquireUseRelease(
            // Acquire: prune stale worktrees (best-effort), create worktree, then start container
            WorktreeManager.pruneStale(hostRepoDir)
              .pipe(
                Effect.catchAll((e) =>
                  Effect.sync(() => {
                    console.error(
                      "[sandcastle] Warning: failed to prune stale worktrees:",
                      e.message,
                    );
                  }),
                ),
              )
              .pipe(
                Effect.andThen(
                  branch
                    ? WorktreeManager.create(hostRepoDir, { branch })
                    : WorktreeManager.create(hostRepoDir, { name }),
                ),
              )
              .pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
              .pipe(
                Effect.flatMap((worktreeInfo) =>
                  (copyPaths && copyPaths.length > 0
                    ? display.spinner(
                        "Copying to sandbox",
                        copyToSandbox(
                          copyPaths,
                          hostRepoDir,
                          worktreeInfo.path,
                        ),
                      )
                    : Effect.succeed(undefined)
                  ).pipe(Effect.map(() => worktreeInfo)),
                ),
              )
              .pipe(
                Effect.flatMap((worktreeInfo) => {
                  const gitDir = join(hostRepoDir, ".git");
                  const volumeMounts = [
                    `${worktreeInfo.path}:${SANDBOX_WORKSPACE_DIR}`,
                    `${gitDir}:${gitDir}`,
                  ];

                  return startSandboxContainer(
                    containerName,
                    imageName,
                    env,
                    volumeMounts,
                  ).pipe(
                    Effect.tap(({ cleanupContainerOnly, onSignal }) =>
                      Effect.sync(() => {
                        // Override the default signal handler to also preserve the worktree
                        process.removeListener("SIGINT", onSignal);
                        process.removeListener("SIGTERM", onSignal);
                        const onSignalWithWorktree = () => {
                          cleanupContainerOnly();
                          printWorktreePreservedMessage(
                            worktreeInfo.path,
                            `Worktree preserved at ${worktreeInfo.path}`,
                          );
                          process.exit(1);
                        };
                        process.on("SIGINT", onSignalWithWorktree);
                        process.on("SIGTERM", onSignalWithWorktree);
                      }),
                    ),
                    Effect.map(({ cleanupContainerOnly, onSignal }) => ({
                      worktreeInfo,
                      cleanupContainerOnly,
                      onSignal,
                    })),
                  );
                }),
              ),
            // Use
            ({ worktreeInfo }) =>
              makeEffect({ hostWorktreePath: worktreeInfo.path }).pipe(
                Effect.provide(makeDockerSandboxLayer(containerName)),
              ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
            // Release: always remove container; remove/preserve worktree based on dirty state.
            ({ worktreeInfo, cleanupContainerOnly, onSignal }, exit) =>
              Effect.sync(() => {
                process.removeListener("exit", cleanupContainerOnly);
                process.removeListener("SIGINT", onSignal);
                process.removeListener("SIGTERM", onSignal);
              }).pipe(
                Effect.andThen(removeContainer(containerName)),
                Effect.andThen(
                  WorktreeManager.hasUncommittedChanges(worktreeInfo.path).pipe(
                    Effect.catchAll(() => Effect.succeed(false)),
                    Effect.flatMap((isDirty) => {
                      if (isDirty) {
                        preservedWorktreePath = worktreeInfo.path;
                        printWorktreePreservedMessage(
                          worktreeInfo.path,
                          Exit.isSuccess(exit)
                            ? `Run succeeded but worktree has uncommitted changes at ${worktreeInfo.path}`
                            : `Worktree preserved at ${worktreeInfo.path}`,
                        );
                        return Effect.void;
                      } else {
                        if (!Exit.isSuccess(exit)) {
                          console.error(
                            `\nWorktree removed (no uncommitted changes)`,
                          );
                        }
                        return WorktreeManager.remove(worktreeInfo.path);
                      }
                    }),
                  ),
                ),
                Effect.orDie,
              ),
          ).pipe(
            Effect.map((value) => ({
              value,
              preservedWorktreePath,
            })),
            // Attach the preserved worktree path to TimeoutError and AgentError so
            // programmatic callers can build on top of the preserved worktree.
            Effect.mapError((e: E | DockerError | WorktreeError) => {
              const path = preservedWorktreePath;
              if (path !== undefined) {
                if (e instanceof TimeoutError) {
                  return new TimeoutError({
                    message: e.message,
                    idleTimeoutSeconds: e.idleTimeoutSeconds,
                    preservedWorktreePath: path,
                  }) as unknown as E | DockerError | WorktreeError;
                }
                if (e instanceof AgentError) {
                  return new AgentError({
                    message: e.message,
                    preservedWorktreePath: path,
                  }) as unknown as E | DockerError | WorktreeError;
                }
              }
              return e;
            }),
          );
        },
      };
    }),
  ),
};
