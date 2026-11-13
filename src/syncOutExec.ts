// Host and sandbox command runners for sync-out, failing with SyncError.

import { Effect } from "effect";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { SyncError } from "./errors.js";
import { hostGit } from "./hostGit.js";

/** Run host git, failing with SyncError on non-zero exit. */
export const execHostGit = (
  args: readonly string[],
  cwd: string,
): Effect.Effect<string, SyncError> =>
  hostGit(args, cwd).pipe(
    Effect.mapError(
      (e) =>
        new SyncError({
          message: `Host command failed: git ${args.join(" ")}\n${e.message}`,
        }),
    ),
  );

/**
 * Execute a command in the sandbox, failing with SyncError if it exits non-zero.
 */
export const execOk = (
  handle: IsolatedSandboxHandle,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<
  { stdout: string; stderr: string; exitCode: number },
  SyncError
> =>
  Effect.tryPromise({
    try: () => handle.exec(command, options),
    catch: (e) =>
      new SyncError({
        message: `Sandbox exec failed: ${command}\n${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new SyncError({
              message: `Sandbox command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
            }),
          ),
    ),
  );

/**
 * Execute a command in the sandbox, returning the result without failing on non-zero exit.
 */
export const execSandbox = (
  handle: IsolatedSandboxHandle,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<
  { stdout: string; stderr: string; exitCode: number },
  SyncError
> =>
  Effect.tryPromise({
    try: () => handle.exec(command, options),
    catch: (e) =>
      new SyncError({
        message: `Sandbox exec failed: ${command}\n${e instanceof Error ? e.message : String(e)}`,
      }),
  });
