import { existsSync, constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  CopyToWorktreeError,
  CopyToWorktreeTimeoutError,
  withTimeout,
} from "./errors.js";

const COPY_TO_WORKTREE_TIMEOUT_MS = 60_000;

/**
 * Recursively copy `src` to `dest`.
 *
 * Why a hand-written walk instead of `cp -R` or `fs.cp`:
 *   On Windows, `npm install` under Git Bash creates `node_modules/.bin/*`
 *   shims as NTFS reparse points (MSYS-style symlinks). GNU `cp` from MSYS
 *   cannot recreate them — first attempt partially populates the destination,
 *   the fallback `cp -R src dest` then sees the partial dir and POSIX-nests
 *   `src` inside it (producing `node_modules/node_modules/.bin/...`).
 *   Node's `fs.cp` fails earlier — `lstat` on those reparse points throws
 *   `EACCES`, aborting the whole walk.
 *
 *   We walk the tree ourselves and silently skip entries whose `lstat` fails
 *   with `EACCES` / `EINVAL`. The sibling `.cmd` / `.ps1` shims that npm
 *   creates alongside each reparse point remain functional, so dropping the
 *   unreadable shim itself is harmless.
 */
const copyTree = async (src: string, dest: string): Promise<void> => {
  let srcStat;
  try {
    srcStat = await lstat(src);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EINVAL") return;
    throw e;
  }

  if (srcStat.isDirectory()) {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src);
    await Promise.all(
      entries.map((name) => copyTree(join(src, name), join(dest, name))),
    );
    return;
  }

  if (srcStat.isSymbolicLink()) {
    const target = await readlink(src);
    try {
      await symlink(target, dest);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }
    return;
  }

  if (srcStat.isFile()) {
    // COPYFILE_FICLONE: prefer copy-on-write (Linux reflink, APFS clonefile).
    // Falls back to a regular byte copy when the filesystem doesn't support it.
    await copyFile(src, dest, fsConstants.COPYFILE_FICLONE);
    return;
  }
  // Sockets, FIFOs, block/character devices: skip.
};

/**
 * Copy files and directories from the host repo root to the worktree root.
 * Missing source paths are silently skipped.
 */
export const copyToWorktree = (
  paths: string[],
  hostRepoDir: string,
  worktreePath: string,
  timeoutMs?: number,
): Effect.Effect<void, CopyToWorktreeTimeoutError | CopyToWorktreeError> => {
  const effectiveTimeout = timeoutMs ?? COPY_TO_WORKTREE_TIMEOUT_MS;
  return Effect.gen(function* () {
    for (const relativePath of paths) {
      const src = join(hostRepoDir, relativePath);
      if (!existsSync(src)) {
        continue;
      }
      const dest = join(worktreePath, relativePath);
      yield* Effect.tryPromise({
        try: () => copyTree(src, dest),
        catch: (e: unknown) => {
          const err = e as NodeJS.ErrnoException;
          const message = err?.message ?? String(e);
          return new CopyToWorktreeError({
            message: `Failed to copy ${relativePath} to worktree: ${message}`,
            path: relativePath,
            stderr: message,
            exitCode: typeof err?.errno === "number" ? err.errno : null,
          });
        },
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
