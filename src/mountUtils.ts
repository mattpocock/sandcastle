/**
 * Shared mount utilities for Docker and Podman sandbox providers.
 *
 * Handles host/sandbox path resolution, tilde expansion, user mount
 * validation, image naming, and Windows path normalization.
 */

import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { Effect } from "effect";
import type { MountConfig } from "./MountConfig.js";
import type { MountEntry } from "./sandboxService.js";
import type { WorktreeError } from "./errors.js";
import {
  PARENT_GIT_SANDBOX_DIR,
  overlayGitMounts,
  parseGitdirPath,
  readWorktreeGitdir,
  writeGitOverride,
} from "./gitMountOverride.js";
import { resolveHostPath, resolveSandboxPath } from "./mountPaths.js";

export {
  PARENT_GIT_SANDBOX_DIR,
  parseGitdirPath,
  removeMountTempDirs,
} from "./gitMountOverride.js";
export {
  expandTilde,
  resolveHostPath,
  resolveSandboxPath,
} from "./mountPaths.js";

/**
 * SELinux volume label suffix applied to bind mounts.
 *
 * - `"z"` — shared label. No-op on non-SELinux systems.
 * - `"Z"` — private label; only this container can access the mount.
 * - `false` — disable labeling entirely.
 */
export type SelinuxLabel = "z" | "Z" | false;

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
