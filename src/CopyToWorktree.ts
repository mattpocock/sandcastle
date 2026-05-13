import { execFile } from "node:child_process";
import { existsSync, rm as fsRm } from "node:fs";
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
        execFile("cp", [...cowFlags, src, dest], (error) => {
          if (error) {
            // The first attempt may have partially populated dest. `cp -R src dest`
            // semantics depend on whether dest exists: missing dest → copy creates
            // it as a clone of src; existing dest dir → src is copied INSIDE as
            // dest/<basename>, doubling the path. Clear dest before retry so the
            // fallback always sees the "fresh" case.
            fsRm(dest, { recursive: true, force: true }, (rmError) => {
              if (rmError) {
                resume(
                  Effect.fail(
                    new CopyToWorktreeError({
                      message: `Failed to clear ${relativePath} before fallback copy: ${rmError.message}`,
                      path: relativePath,
                      stderr: rmError.message,
                      exitCode: null,
                    }),
                  ),
                );
                return;
              }
              execFile("cp", ["-R", src, dest], (fallbackError, _, stderr) => {
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
              });
            });
          } else {
            resume(Effect.succeed(undefined));
          }
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
