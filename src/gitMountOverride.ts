/**
 * The pieces of the Windows git-mount fix (ADR-0006) that
 * `patchGitMountsForWindows` in `mountUtils.ts` puts together: reading a
 * worktree's `gitdir:` pointer, writing the corrected `.git` override file,
 * overlaying it on the git mounts, and removing its temp dir afterwards.
 */

import { rm as rmCallback } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import type { MountEntry } from "./sandboxService.js";
import { WorktreeError } from "./errors.js";

/**
 * Deterministic mount point inside the sandbox for the parent repo's .git
 * directory when the workspace is a git worktree. See ADR-0006.
 */
export const PARENT_GIT_SANDBOX_DIR = "/.sandcastle-parent-git";

/**
 * Parse a `gitdir:` path into its parent .git directory and worktree name.
 *
 * The gitdir path is like `/path/to/repo/.git/worktrees/<name>` or
 * `C:\Users\project\.git\worktrees\<name>`. We split on both `/` and `\`
 * so this works regardless of the host platform or which platform runs tests.
 */
export const parseGitdirPath = (
  gitdirPath: string,
): { parentGitDir: string; worktreeName: string } => {
  const normalized = gitdirPath.replaceAll("\\", "/").replace(/\/+$/u, "");
  const segments = normalized.split("/");
  const worktreeName = segments.pop() ?? ""; // <name>
  segments.pop(); // "worktrees"
  const parentGitDir = segments.join("/");
  return { worktreeName, parentGitDir };
};

/**
 * The `gitdir:` path a worktree's `.git` file points at, or `undefined` when
 * `.git` is missing, unreadable, a directory, or not a `gitdir:` pointer.
 */
export const readWorktreeGitdir = (
  gitEntryPath: string,
  fileAccess: {
    readonly readFile: (path: string) => Promise<string>;
    readonly statFile: (path: string) => Promise<"file" | "directory">;
  },
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const { readFile, statFile } = fileAccess;

    const gitEntryType = yield* Effect.tryPromise({
      try: () => statFile(gitEntryPath),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
    // .git is a directory (normal clone): no gitdir indirection to fix.
    // `normalizeMounts` already remaps the .git mount to `${sandboxRepoDir}/.git`
    // because the host .git sits under `worktreeHostPath`. Removing this short-
    // circuit would break head mode against a normal clone.
    if (gitEntryType === null || gitEntryType === "directory") {
      return undefined;
    }

    const content = yield* Effect.tryPromise({
      try: () => readFile(gitEntryPath),
      catch: () => null,
    }).pipe(
      Effect.map((s) => s.trim()),
      Effect.catchAll(() => Effect.succeed(null)),
    );
    if (content === null) {
      return undefined;
    }
    return /^gitdir:\s*(?<gitdir>.+)$/u.exec(content)?.groups?.gitdir;
  });

/**
 * Writes a `.git` override file pointing at `correctedGitdir` into a fresh
 * temp dir. Returns the file and its temp dir.
 */
export const writeGitOverride = (
  correctedGitdir: string,
): Effect.Effect<
  { readonly hostPath: string; readonly tempDir: string },
  WorktreeError
> =>
  Effect.gen(function* () {
    const tempDir = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "sandcastle-git-")),
      catch: (e) =>
        new WorktreeError({
          message: `Failed to create temp dir for git override: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });
    const tempGitFile = join(tempDir, "git-override");
    yield* Effect.tryPromise({
      try: () => writeFile(tempGitFile, `gitdir: ${correctedGitdir}\n`),
      catch: (e) =>
        new WorktreeError({
          message: `Failed to write git override file: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }).pipe(
      Effect.tapError(() =>
        removeMountTempDirs([
          { hostPath: tempGitFile, sandboxPath: "", tempDir },
        ]),
      ),
    );
    return { hostPath: tempGitFile, tempDir };
  });

/**
 * Remaps the parent `.git` dir mount to `PARENT_GIT_SANDBOX_DIR` and puts
 * `overrideMount` in place of the worktree's `.git` file mount, or adds it
 * when there is none (a Sandcastle-created worktree).
 */
export const overlayGitMounts = (
  gitMounts: MountEntry[],
  paths: {
    readonly parentGitDir: string;
    readonly gitEntryPath: string;
    readonly overrideMount: MountEntry;
  },
): MountEntry[] => {
  const normalizedParentGitDir = paths.parentGitDir.replaceAll("\\", "/");
  const gitFileHostPath = paths.gitEntryPath.replaceAll("\\", "/");

  const correctedMounts: MountEntry[] = [];
  let replacedGitFile = false;

  for (const m of gitMounts) {
    const normalizedHostPath = m.hostPath.replaceAll("\\", "/");
    if (normalizedHostPath === normalizedParentGitDir) {
      // Remap parent .git dir to deterministic sandbox path
      correctedMounts.push({ ...m, sandboxPath: PARENT_GIT_SANDBOX_DIR });
    } else if (normalizedHostPath === gitFileHostPath) {
      // Replace .git file mount with corrected version (host repo is a worktree)
      correctedMounts.push({ ...m, ...paths.overrideMount });
      replacedGitFile = true;
    } else {
      correctedMounts.push(m);
    }
  }

  if (!replacedGitFile) {
    correctedMounts.push(paths.overrideMount);
  }

  return correctedMounts;
};

/**
 * Removes the temp dirs `patchGitMountsForWindows` created for `mounts`
 * (none off Windows). Run it once the sandbox using the mounts has closed, or
 * failed to start.
 */
export const removeMountTempDirs = (
  mounts: readonly MountEntry[],
): Effect.Effect<void> =>
  Effect.forEach(
    mounts.flatMap((m) => (m.tempDir === undefined ? [] : [m.tempDir])),
    (dir) =>
      // A dir that can't be removed is left behind; nothing depends on it.
      Effect.async<NodeJS.ErrnoException | null>((resume) => {
        rmCallback(dir, { recursive: true, force: true }, (error) => {
          resume(Effect.succeed(error));
        });
      }),
    { discard: true },
  );
