import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  CopyToWorktreeError,
  CopyToWorktreeTimeoutError,
  withTimeout,
} from "./errors.js";

const COPY_TO_WORKTREE_TIMEOUT_MS = 60_000;

/**
 * Returns cp flags for copy-on-write support:
 * - macOS (darwin): `-cR` uses APFS clonefile
 * - Other (Linux, etc.): `-R --reflink=auto` uses GNU coreutils reflink
 */
export const getCopyOnWriteFlags = (platform: string): string[] =>
  platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];

/**
 * Copy files and directories from the host repo root to the worktree root,
 * using copy-on-write when the filesystem supports it.
 * Missing paths are silently skipped.
 */
export const copyToWorktree = (
  paths: string[],
  hostRepoDir: string,
  worktreePath: string,
  timeoutMs?: number,
): Effect.Effect<void, CopyToWorktreeTimeoutError | CopyToWorktreeError> => {
  const effectiveTimeout = timeoutMs ?? COPY_TO_WORKTREE_TIMEOUT_MS;
  return Effect.gen(function* () {
    const cowFlags = getCopyOnWriteFlags(process.platform);
    for (const relativePath of paths) {
      const src = join(hostRepoDir, relativePath);
      if (!existsSync(src)) {
        continue;
      }
      const dest = join(worktreePath, relativePath);
      yield* Effect.async<void, CopyToWorktreeError>((resume) => {
        // One controller covers both the copy-on-write attempt and its
        // fallback. Interruption (e.g. the timeout below) kills whichever
        // child is running and stops the fallback from ever starting;
        // without it an orphaned `cp` keeps writing into a worktree the
        // caller has already begun tearing down.
        const controller = new AbortController();
        const { signal } = controller;

        execFile("cp", [...cowFlags, src, dest], { signal }, (error) => {
          if (signal.aborted) {
            return;
          }
          if (error) {
            // Fall back to a regular copy if copy-on-write is not supported
            execFile(
              "cp",
              ["-R", src, dest],
              { signal },
              (fallbackError, _, stderr) => {
                if (signal.aborted) {
                  return;
                }
                if (fallbackError) {
                  resume(
                    Effect.fail(
                      new CopyToWorktreeError({
                        message: `Failed to copy ${relativePath} to worktree: ${stderr || fallbackError.message}`,
                        path: relativePath,
                        stderr: stderr || fallbackError.message,
                        exitCode:
                          typeof fallbackError.code === "number"
                            ? fallbackError.code
                            : null,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          } else {
            resume(Effect.succeed(undefined));
          }
        });

        return Effect.sync(() => {
          controller.abort();
        });
      });
    }
  }).pipe(
    withTimeout(
      effectiveTimeout,
      () =>
        new CopyToWorktreeTimeoutError({
          message: `Copying files to worktree timed out after ${effectiveTimeout}ms`,
          timeoutMs: effectiveTimeout,
          paths,
        }),
    ),
  );
};
