import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
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
 * Each path lands at the same relative path in the worktree: a directory is
 * merged into one that already exists there (e.g. a tracked dir holding
 * ignored files), and missing parent directories are created.
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
      const isDirectory = statSync(src).isDirectory();
      // For a directory, create dest itself and copy its contents (`src/.`)
      // so an existing dest is merged into rather than nested (`cfg/cfg`).
      // For a file, create its parent dirs so a nested path can land.
      const dirToCreate = isDirectory ? dest : dirname(dest);
      const cpSrc = isDirectory ? `${src}${sep}.` : src;
      yield* Effect.tryPromise({
        try: () => mkdir(dirToCreate, { recursive: true }),
        catch: (e) => {
          const message = e instanceof Error ? e.message : String(e);
          return new CopyToWorktreeError({
            message: `Failed to copy ${relativePath} to worktree: ${message}`,
            path: relativePath,
            stderr: message,
            exitCode: null,
          });
        },
      });
      yield* Effect.async<void, CopyToWorktreeError>((resume) => {
        // The cp currently running, killed if the copy is interrupted (e.g.
        // by the timeout below) so it can't keep writing into the worktree.
        let child: ChildProcess;
        // Set once the copy is interrupted. Killing the cp makes its callback
        // fire with an error, which must not start the fallback cp: nothing
        // would kill that one.
        let interrupted = false;
        child = execFile("cp", [...cowFlags, cpSrc, dest], (error) => {
          if (interrupted) {
            return;
          }
          if (error) {
            // Fall back to a regular copy if copy-on-write is not supported
            child = execFile(
              "cp",
              ["-R", cpSrc, dest],
              (fallbackError, _, stderr) => {
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
                  resume(Effect.void);
                }
              },
            );
          } else {
            resume(Effect.void);
          }
        });
        return Effect.sync(() => {
          interrupted = true;
          child.kill("SIGKILL");
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
