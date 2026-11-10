/**
 * Shared mount utilities for Docker and Podman sandbox providers.
 *
 * Handles host/sandbox path resolution, tilde expansion, user mount
 * validation, image naming, and Windows path normalization.
 */

import { existsSync, rm as rmCallback, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { isAbsolute, resolve, join, dirname } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import type { MountConfig } from "./MountConfig.js";
import { SANDBOX_REPO_DIR } from "./sandboxService.js";
import type { MountEntry } from "./sandboxService.js";
import { WorktreeError } from "./errors.js";

/**
 * SELinux volume label suffix applied to bind mounts.
 *
 * - `"z"` — shared label. No-op on non-SELinux systems.
 * - `"Z"` — private label; only this container can access the mount.
 * - `false` — disable labeling entirely.
 */
export type SelinuxLabel = "z" | "Z" | false;

/**
 * Deterministic mount point inside the sandbox for the parent repo's .git
 * directory when the workspace is a git worktree. See ADR-0006.
 */
export const PARENT_GIT_SANDBOX_DIR = "/.sandcastle-parent-git";

/**
 * Derive the default image name from the repo directory.
 * Returns `sandcastle:<dir-name>` where dir-name is the last path segment,
 * lowercased and sanitized for image tag rules.
 *
 * Handles both POSIX (`/`) and Windows (`\`) path separators.
 */
export const defaultImageName = (repoDir: string): string => {
  const dirName =
    repoDir
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .pop() ?? "local";
  // One dash per UTF-16 unit, as before the `u` flag, so the default image
  // name for a directory with an astral character (e.g. an emoji) is unchanged.
  const sanitized = dirName
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]/gu, (char) => "-".repeat(char.length));
  return `sandcastle:${sanitized || "local"}`;
};

/**
 * Expand tilde (`~`) to the given home directory (or `os.homedir()` if omitted).
 * Handles both `~/path` (POSIX) and `~\path` (Windows).
 */
export const expandTilde = (p: string, homeDirPath?: string): string => {
  const home = homeDirPath ?? homedir();
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return `${home}/${p.slice(2)}`;
  }
  return p;
};

/**
 * Resolve a host path: expand tilde, then resolve relative paths from `process.cwd()`.
 */
export const resolveHostPath = (hostPath: string): string => {
  const expanded = expandTilde(hostPath);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
};

/**
 * Resolve a sandbox path: expands tilde using `sandboxHomedir`, then resolves
 * relative paths from `SANDBOX_REPO_DIR`.
 *
 * Throws if `sandboxPath` starts with `~` but `sandboxHomedir` is `undefined`.
 */
export const resolveSandboxPath = (
  sandboxPath: string,
  sandboxHomedir?: string,
): string => {
  const hasTilde =
    sandboxPath === "~" ||
    sandboxPath.startsWith("~/") ||
    sandboxPath.startsWith("~\\");
  if (hasTilde && sandboxHomedir === undefined) {
    throw new Error(
      `sandboxPath "${sandboxPath}" contains a tilde but the provider has no sandboxHomedir set`,
    );
  }
  const expanded = hasTilde
    ? expandTilde(sandboxPath, sandboxHomedir)
    : sandboxPath;
  return isAbsolute(expanded) ? expanded : resolve(SANDBOX_REPO_DIR, expanded);
};

/**
 * Resolve and validate user-provided mount configurations.
 * Throws if a hostPath does not exist on the filesystem.
 * Throws if a sandboxPath uses tilde but `sandboxHomedir` is `undefined`.
 */
export const resolveUserMounts = (
  mounts: readonly MountConfig[],
  sandboxHomedir?: string,
): { hostPath: string; sandboxPath: string; readonly?: boolean }[] =>
  mounts.map((m) => {
    const resolvedHostPath = resolveHostPath(m.hostPath);

    if (!existsSync(resolvedHostPath)) {
      throw new Error(
        `Mount hostPath does not exist: ${m.hostPath}${
          m.hostPath === resolvedHostPath
            ? ""
            : ` (resolved to ${resolvedHostPath})`
        }`,
      );
    }

    return {
      hostPath: resolvedHostPath,
      sandboxPath: resolveSandboxPath(m.sandboxPath, sandboxHomedir),
      ...(m.readonly === true ? { readonly: true } : {}),
    };
  });

/**
 * Normalize mount entries for cross-platform compatibility.
 *
 * On Windows (`platform === "win32"`):
 * - Replaces backslashes with forward slashes in all `hostPath` values
 * - Remaps `sandboxPath` values that look like Windows paths to valid POSIX
 *   paths relative to `sandboxRepoDir` when the host path is under the
 *   worktree host path
 *
 * On non-Windows platforms, returns mounts unchanged (preserving
 * `sandboxPath === hostPath` for git mounts so that `gitdir:` references
 * resolve correctly inside the container).
 *
 * This is a pure function — no filesystem access, accepts a `platform`
 * parameter so it can be unit-tested with fake Windows paths.
 */
export const normalizeMounts = <
  M extends { hostPath: string; sandboxPath: string },
>(
  mounts: M[],
  repo: { readonly worktreeHostPath: string; readonly sandboxRepoDir: string },
  platform: string = process.platform,
): M[] => {
  if (platform !== "win32") {
    return mounts;
  }
  const { worktreeHostPath, sandboxRepoDir } = repo;

  const normalizedWorktree = worktreeHostPath.replaceAll("\\", "/");

  return mounts.map((m) => {
    const hostPath = m.hostPath.replaceAll("\\", "/");
    let { sandboxPath } = m;

    // If sandboxPath is already a valid POSIX absolute path (e.g., user-specified
    // sandbox paths like /mnt/data or /home/agent/workspace), leave it as-is.
    // Otherwise, normalize it — Windows-style sandboxPaths (from resolveGitMounts
    // setting sandboxPath === hostPath) need remapping.
    if (/^[A-Za-z]:[/\\]/u.test(sandboxPath) || sandboxPath.includes("\\")) {
      // This is a Windows-style path — remap it
      const normalizedSandboxPath = sandboxPath.replaceAll("\\", "/");

      if (normalizedSandboxPath.startsWith(`${normalizedWorktree}/`)) {
        // Under the worktree: derive sandbox path relative to sandboxRepoDir
        const relativeSuffix = normalizedSandboxPath.slice(
          normalizedWorktree.length,
        );
        sandboxPath = sandboxRepoDir + relativeSuffix;
      } else if (normalizedSandboxPath === normalizedWorktree) {
        sandboxPath = sandboxRepoDir;
      } else {
        // Not under the worktree — just normalize slashes
        sandboxPath = normalizedSandboxPath;
      }
    }

    return { ...m, hostPath, sandboxPath };
  });
};

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
 * On Windows, patch git mounts so that worktree `.git` files resolve inside
 * the Linux sandbox. See ADR-0006 for the full rationale.
 *
 * Two fixes are applied:
 * 1. The parent `.git` directory mount is remapped to `PARENT_GIT_SANDBOX_DIR`.
 * 2. A corrected `.git` file (with a POSIX `gitdir:` path) is created and
 *    mounted read-only at `sandboxRepoDir/.git`, overlaying the original. Its
 *    temp dir is named on the mount (`tempDir`) and removed by `startSandbox`
 *    when the sandbox closes.
 *
 * On non-Windows platforms, or when the worktree's `.git` is a directory
 * (not a worktree pointer), returns the mounts unchanged.
 *
 * @param gitMounts - Raw mounts from `resolveGitMounts`.
 * @param worktreeHostPath - Host path to the directory mounted at `sandboxRepoDir`.
 * @param sandboxRepoDir - Where the worktree is mounted inside the sandbox.
 * @param readFile - Read a file's content (injectable for tests).
 * @param statFile - Stat a file to check if it's a directory (injectable for tests).
 * @param platform - Override for `process.platform` (injectable for tests).
 */
export const patchGitMountsForWindows = (
  gitMounts: MountEntry[],
  worktreeHostPath: string,
  sandboxRepoDir: string,
  readFile?: (path: string) => Promise<string>,
  statFile?: (path: string) => Promise<"file" | "directory">,
  platform: string = process.platform,
): Effect.Effect<MountEntry[], WorktreeError> =>
  Effect.gen(function* () {
    if (platform !== "win32") {
      return gitMounts;
    }

    const gitEntryPath = join(worktreeHostPath, ".git");
    const gitdirPath = yield* readWorktreeGitdir(gitEntryPath, {
      readFile: readFile ?? defaultReadFile,
      statFile: statFile ?? defaultStatFile,
    });
    if (gitdirPath === undefined) {
      return gitMounts;
    }

    const { parentGitDir, worktreeName } = parseGitdirPath(gitdirPath);
    const override = yield* writeGitOverride(
      `${PARENT_GIT_SANDBOX_DIR}/worktrees/${worktreeName}`,
    );
    return overlayGitMounts(gitMounts, {
      parentGitDir,
      gitEntryPath,
      overrideMount: {
        ...override,
        sandboxPath: `${sandboxRepoDir}/.git`,
        readonly: true,
      },
    });
  });

const defaultReadFile = async (p: string): Promise<string> => {
  const { readFile: rf } = await import("node:fs/promises");
  return rf(p, "utf8");
};

const defaultStatFile = async (p: string): Promise<"file" | "directory"> => {
  const { stat } = await import("node:fs/promises");
  const s = await stat(p);
  return s.isDirectory() ? ("directory" as const) : ("file" as const);
};

/**
 * The `gitdir:` path a worktree's `.git` file points at, or `undefined` when
 * `.git` is missing, unreadable, a directory, or not a `gitdir:` pointer.
 */
const readWorktreeGitdir = (
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
const writeGitOverride = (
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
const overlayGitMounts = (
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

/**
 * Format a bind mount into a `-v` style string for container runtimes.
 *
 * Produces: `hostPath:sandboxPath[:ro][,z|Z]`
 *
 * Used by both Podman and Docker providers.
 */
export const formatVolumeMount = (
  mount: { hostPath: string; sandboxPath: string; readonly?: boolean },
  selinuxLabel: SelinuxLabel | undefined,
): string => {
  const base = `${mount.hostPath}:${mount.sandboxPath}`;
  const options = [
    mount.readonly === true ? "ro" : undefined,
    selinuxLabel === false ? undefined : selinuxLabel,
  ]
    .filter((option): option is string => option !== undefined)
    .join(",");

  return options ? `${base}:${options}` : base;
};

/**
 * Detect file-target mounts whose sandbox-side parent directory may not
 * exist in the container image, and return the parent dirs that need to
 * be created at container start.
 *
 * Validates at config time: if a file mount's sandbox parent is outside
 * `sandboxHomedir`, throws with a clear error and remediation guidance.
 *
 * For file mounts whose parent is under `sandboxHomedir` (but not equal
 * to it — `/home/agent` always exists), returns the unique set of parent
 * directories that must be `mkdir -p` + `chown`'d before the agent runs.
 *
 * @param mounts - Resolved mounts (hostPath already validated to exist).
 * @param sandboxHomedir - The agent's home directory in the sandbox (e.g. `/home/agent`).
 * @param statFn - Injectable stat function for testing (defaults to `statSync`).
 */
export const processFileMountParents = (
  mounts: readonly { hostPath: string; sandboxPath: string }[],
  sandboxHomedir: string,
  statFn: (path: string) => { isFile(): boolean } = statSync,
): string[] => {
  const parentDirs = new Set<string>();

  for (const mount of mounts) {
    let isFile: boolean;
    try {
      isFile = statFn(mount.hostPath).isFile();
    } catch {
      continue;
    }

    if (!isFile) {
      continue;
    }

    const parentDir = dirname(mount.sandboxPath);

    // Parent IS sandboxHomedir — it always exists in the image
    if (parentDir === sandboxHomedir) {
      continue;
    }

    // Parent is outside sandboxHomedir — fail at config time
    if (!parentDir.startsWith(`${sandboxHomedir}/`)) {
      throw new Error(
        `Cannot mount file to '${mount.sandboxPath}': ` +
          `parent directory '${parentDir}' is outside the sandbox home directory ('${sandboxHomedir}'). ` +
          `Mount the parent directory instead, or rebuild the image with '${parentDir}' pre-created.`,
      );
    }

    parentDirs.add(parentDir);
  }

  return [...parentDirs];
};
