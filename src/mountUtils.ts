/**
 * Shared mount utilities for Docker and Podman sandbox providers.
 *
 * Handles host/sandbox path resolution, tilde expansion, user mount
 * validation, image naming, and Windows path normalization.
 */

import { existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { isAbsolute, resolve, join, dirname } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { MountConfig } from "./MountConfig.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";

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
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized || "local"}`;
};

/**
 * Expand tilde (`~`) to the given home directory (or `os.homedir()` if omitted).
 * Handles both `~/path` (POSIX) and `~\path` (Windows).
 */
export const expandTilde = (p: string, homeDirPath?: string): string => {
  const home = homeDirPath ?? homedir();
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return home + "/" + p.slice(2);
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
): Array<{ hostPath: string; sandboxPath: string; readonly?: boolean }> =>
  mounts.map((m) => {
    const resolvedHostPath = resolveHostPath(m.hostPath);

    if (!existsSync(resolvedHostPath)) {
      throw new Error(
        `Mount hostPath does not exist: ${m.hostPath}` +
          (m.hostPath !== resolvedHostPath
            ? ` (resolved to ${resolvedHostPath})`
            : ""),
      );
    }

    return {
      hostPath: resolvedHostPath,
      sandboxPath: resolveSandboxPath(m.sandboxPath, sandboxHomedir),
      ...(m.readonly ? { readonly: true } : {}),
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
  worktreeHostPath: string,
  sandboxRepoDir: string,
  platform: string = process.platform,
): M[] => {
  if (platform !== "win32") return mounts;

  const normalizedWorktree = worktreeHostPath.replace(/\\/g, "/");

  return mounts.map((m) => {
    const hostPath = m.hostPath.replace(/\\/g, "/");
    let sandboxPath = m.sandboxPath;

    // If sandboxPath is already a valid POSIX absolute path (e.g., user-specified
    // sandbox paths like /mnt/data or /home/agent/workspace), leave it as-is.
    // Otherwise, normalize it — Windows-style sandboxPaths (from resolveGitMounts
    // setting sandboxPath === hostPath) need remapping.
    if (/^[A-Za-z]:[/\\]/.test(sandboxPath) || sandboxPath.includes("\\")) {
      // This is a Windows-style path — remap it
      const normalizedSandboxPath = sandboxPath.replace(/\\/g, "/");

      if (normalizedSandboxPath.startsWith(normalizedWorktree + "/")) {
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
  const normalized = gitdirPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/");
  const worktreeName = segments.pop()!; // <name>
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
 *    mounted at `sandboxRepoDir/.git`, overlaying the original.
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
export const patchGitMountsForWindows = async (
  gitMounts: Array<{ hostPath: string; sandboxPath: string }>,
  worktreeHostPath: string,
  sandboxRepoDir: string,
  readFile?: (path: string) => Promise<string>,
  statFile?: (path: string) => Promise<"file" | "directory">,
  platform: string = process.platform,
): Promise<Array<{ hostPath: string; sandboxPath: string }>> => {
  if (platform !== "win32") return gitMounts;

  const _readFile =
    readFile ??
    (async (p: string) => {
      const { readFile: rf } = await import("node:fs/promises");
      return rf(p, "utf-8");
    });
  const _statFile =
    statFile ??
    (async (p: string) => {
      const { stat } = await import("node:fs/promises");
      const s = await stat(p);
      return s.isDirectory() ? ("directory" as const) : ("file" as const);
    });

  // Check the worktree's .git entry
  const gitEntryPath = join(worktreeHostPath, ".git");
  let gitEntryType: "file" | "directory";
  try {
    gitEntryType = await _statFile(gitEntryPath);
  } catch {
    return gitMounts;
  }
  if (gitEntryType === "directory") return gitMounts;

  // Read and parse the gitdir: line
  let content: string;
  try {
    content = (await _readFile(gitEntryPath)).trim();
  } catch {
    return gitMounts;
  }
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) return gitMounts;

  const gitdirPath = match[1]!;
  const { parentGitDir, worktreeName } = parseGitdirPath(gitdirPath);

  // Create a temp file with the corrected gitdir content
  const correctedGitdir = `${PARENT_GIT_SANDBOX_DIR}/worktrees/${worktreeName}`;
  const tempDir = await mkdtemp(join(tmpdir(), "sandcastle-git-"));
  const tempGitFile = join(tempDir, "git-override");
  await writeFile(tempGitFile, `gitdir: ${correctedGitdir}\n`);

  // Build corrected mounts
  const normalizedParentGitDir = parentGitDir.replace(/\\/g, "/");
  const gitFileHostPath = gitEntryPath.replace(/\\/g, "/");

  const correctedMounts: Array<{ hostPath: string; sandboxPath: string }> = [];
  let replacedGitFile = false;

  for (const m of gitMounts) {
    const normalizedHostPath = m.hostPath.replace(/\\/g, "/");
    if (normalizedHostPath === normalizedParentGitDir) {
      // Remap parent .git dir to deterministic sandbox path
      correctedMounts.push({ ...m, sandboxPath: PARENT_GIT_SANDBOX_DIR });
    } else if (normalizedHostPath === gitFileHostPath) {
      // Replace .git file mount with corrected version (host repo is a worktree)
      correctedMounts.push({
        ...m,
        hostPath: tempGitFile,
        sandboxPath: `${sandboxRepoDir}/.git`,
      });
      replacedGitFile = true;
    } else {
      correctedMounts.push(m);
    }
  }

  // If the .git file wasn't in gitMounts (Sandcastle-created worktree),
  // add an overlay mount for the corrected .git file
  if (!replacedGitFile) {
    correctedMounts.push({
      hostPath: tempGitFile,
      sandboxPath: `${sandboxRepoDir}/.git`,
    });
  }

  return correctedMounts;
};

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
  const options = [mount.readonly ? "ro" : undefined, selinuxLabel || undefined]
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
  mounts: ReadonlyArray<{ hostPath: string; sandboxPath: string }>,
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

    if (!isFile) continue;

    const parentDir = dirname(mount.sandboxPath);

    // Parent IS sandboxHomedir — it always exists in the image
    if (parentDir === sandboxHomedir) continue;

    // Parent is outside sandboxHomedir — fail at config time
    if (!parentDir.startsWith(sandboxHomedir + "/")) {
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
