/**
 * Sync-out: extract changes from an isolated sandbox back to the host.
 *
 * Two-phase approach:
 * 1. Save phase: eagerly save all artifacts (patches, diff, untracked files)
 *    to `.sandcastle/patches/<timestamp>/` before attempting to apply.
 * 2. Apply phase: apply from the saved directory.
 *    - On success: clean up the patch directory.
 *    - On failure: preserve the patch directory and print recovery commands.
 *
 * Three-prong extraction within each phase:
 * 1. Committed changes: `git format-patch` + `git am --3way`
 * 2. Uncommitted changes (staged + unstaged): `git diff HEAD` + `git apply`
 * 3. Untracked files: `git ls-files --others` + `copyFileOut` each file
 */

import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { buildRecoveryMessage, type FailedStep } from "./RecoveryMessage.js";
import { SyncError } from "./errors.js";
import { resolveNamespace } from "./WorktreeManager.js";

/**
 * Execute a command on the host side, returning stdout.
 * Fails with SyncError on non-zero exit.
 */
const execHost = (
  command: string,
  cwd: string,
): Effect.Effect<string, SyncError> =>
  Effect.tryPromise({
    try: async () => {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      const { stdout } = await execAsync(command, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    },
    catch: (e) =>
      new SyncError({
        message: `Host command failed: ${command}\n${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/**
 * Execute a command in the sandbox, failing with SyncError if it exits non-zero.
 */
const execOk = (
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
      result.exitCode !== 0
        ? Effect.fail(
            new SyncError({
              message: `Sandbox command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
            }),
          )
        : Effect.succeed(result),
    ),
  );

/**
 * Execute a command in the sandbox, returning the result without failing on non-zero exit.
 */
const execSandbox = (
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

/**
 * Check if a patch file is empty or header-only.
 * Merge commits produce patches with headers but no diff content.
 * A patch is considered empty if it has no lines starting with "diff --git".
 */
const isEmptyPatch = (patchPath: string): Effect.Effect<boolean, SyncError> =>
  Effect.tryPromise({
    try: async () => {
      const info = await stat(patchPath);
      if (info.size === 0) return true;
      const content = await readFile(patchPath, "utf-8");
      return !content.includes("diff --git");
    },
    catch: (e) =>
      new SyncError({
        message: `Failed to check patch ${patchPath}: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/**
 * Generate a YYYYMMDD-HHMMSS timestamp directory name.
 * Appends a counter suffix (-1, -2, ...) if the directory already exists.
 */
const createPatchDir = (
  hostRepoDir: string,
  namespace: string,
): Effect.Effect<string, SyncError> =>
  Effect.tryPromise({
    try: async () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

      const patchesRoot = join(hostRepoDir, `.${namespace}`, "patches");
      await mkdir(patchesRoot, { recursive: true });

      let dirName = base;
      let counter = 0;
      while (existsSync(join(patchesRoot, dirName))) {
        counter++;
        dirName = `${base}-${counter}`;
      }

      const patchDir = join(patchesRoot, dirName);
      await mkdir(patchDir, { recursive: true });
      return patchDir;
    },
    catch: (e) =>
      new SyncError({
        message: `Failed to create patch directory: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/**
 * Sync changes from an isolated sandbox back to the host repo.
 *
 * Two-phase extraction with artifact persistence:
 * 1. Save all artifacts to `.<namespace>/patches/<timestamp>/`
 * 2. Apply from saved directory; on failure, preserve artifacts and print recovery
 */
export const syncOut = (
  hostRepoDir: string,
  handle: IsolatedSandboxHandle,
  namespace?: string,
): Effect.Effect<void, SyncError> =>
  Effect.gen(function* () {
    const ns = resolveNamespace(namespace);
    const worktreePath = handle.worktreePath;

    const hostHead = (yield* execHost(
      "git rev-parse HEAD",
      hostRepoDir,
    )).trim();
    const sandboxHead = (yield* execOk(handle, "git rev-parse HEAD", {
      cwd: worktreePath,
    })).stdout.trim();

    const hasCommits = hostHead !== sandboxHead;

    // Check for uncommitted changes
    const diffResult = yield* execSandbox(handle, "git diff HEAD", {
      cwd: worktreePath,
    });
    const hasDiff =
      diffResult.exitCode === 0 && diffResult.stdout.trim().length > 0;

    // Check for untracked files
    const lsFilesResult = yield* execSandbox(
      handle,
      "git ls-files --others --exclude-standard",
      { cwd: worktreePath },
    );
    const hasUntracked =
      lsFilesResult.exitCode === 0 && lsFilesResult.stdout.trim().length > 0;

    const untrackedFiles = hasUntracked
      ? lsFilesResult.stdout
          .trim()
          .split("\n")
          .filter((f) => f.length > 0)
      : [];

    // Nothing to sync
    if (!hasCommits && !hasDiff && !hasUntracked) {
      return;
    }

    // --- Phase 1: Save all artifacts ---
    const patchDir = yield* createPatchDir(hostRepoDir, ns);
    const relativePatchDir = join(`.${ns}`, "patches", basename(patchDir));

    const nonEmptyPatches: string[] = [];

    // Save committed patches
    if (hasCommits) {
      const mkTempResult = yield* execOk(
        handle,
        "mktemp -d -t sandcastle-patches-XXXXXX",
      );
      const sandboxPatchDir = mkTempResult.stdout.trim();

      try {
        yield* execOk(
          handle,
          `git format-patch "${hostHead}..HEAD" -o "${sandboxPatchDir}"`,
          { cwd: worktreePath },
        );

        const lsResult = yield* execOk(handle, `ls -1 "${sandboxPatchDir}"`);
        const patchNames = lsResult.stdout
          .trim()
          .split("\n")
          .filter((name) => name.length > 0);

        for (const patchName of patchNames) {
          const sandboxPatchPath = `${sandboxPatchDir}/${patchName}`;
          const hostPatchPath = join(patchDir, patchName);
          yield* Effect.tryPromise({
            try: () => handle.copyFileOut(sandboxPatchPath, hostPatchPath),
            catch: (e) =>
              new SyncError({
                message: `Failed to copy patch ${patchName}: ${e instanceof Error ? e.message : String(e)}`,
              }),
          });

          if (!(yield* isEmptyPatch(hostPatchPath))) {
            nonEmptyPatches.push(hostPatchPath);
          }
        }
      } finally {
        yield* execSandbox(handle, `rm -rf "${sandboxPatchDir}"`);
      }
    }

    // Save uncommitted diff
    if (hasDiff) {
      const diffPath = join(patchDir, "changes.patch");
      yield* Effect.tryPromise({
        try: () => writeFile(diffPath, diffResult.stdout),
        catch: (e) =>
          new SyncError({
            message: `Failed to write diff patch: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
    }

    // Save untracked files
    if (hasUntracked) {
      const untrackedDir = join(patchDir, "untracked");
      for (const relPath of untrackedFiles) {
        const sandboxFilePath = `${worktreePath}/${relPath}`;
        const hostFilePath = join(untrackedDir, relPath);
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(hostFilePath), { recursive: true });
            await handle.copyFileOut(sandboxFilePath, hostFilePath);
          },
          catch: (e) =>
            new SyncError({
              message: `Failed to save untracked file ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
            }),
        });
      }
    }

    // --- Phase 2: Apply from saved directory ---
    let failedStep: FailedStep | undefined;

    // Apply committed patches
    if (nonEmptyPatches.length > 0) {
      const abortResult = yield* Effect.either(
        execHost("git am --abort", hostRepoDir),
      );
      void abortResult; // ignore abort failures
      const patchArgs = nonEmptyPatches.map((p) => `"${p}"`).join(" ");
      const applyResult = yield* Effect.either(
        execHost(`git am --3way ${patchArgs}`, hostRepoDir),
      );
      if (applyResult._tag === "Left") {
        failedStep = "commits";
      }
    }

    // Apply uncommitted diff
    if (!failedStep && hasDiff) {
      const diffPath = join(patchDir, "changes.patch");
      const applyResult = yield* Effect.either(
        execHost(`git apply "${diffPath}"`, hostRepoDir),
      );
      if (applyResult._tag === "Left") {
        failedStep = "diff";
      }
    }

    // Copy untracked files
    if (!failedStep && hasUntracked) {
      const copyResult = yield* Effect.either(
        Effect.tryPromise({
          try: async () => {
            const untrackedDir = join(patchDir, "untracked");
            for (const relPath of untrackedFiles) {
              const srcPath = join(untrackedDir, relPath);
              const destPath = join(hostRepoDir, relPath);
              await mkdir(dirname(destPath), { recursive: true });
              const content = await readFile(srcPath);
              await writeFile(destPath, content);
            }
          },
          catch: (e) =>
            new SyncError({
              message: `Failed to copy untracked files: ${e instanceof Error ? e.message : String(e)}`,
            }),
        }),
      );
      if (copyResult._tag === "Left") {
        failedStep = "untracked";
      }
    }

    // --- Cleanup or preserve ---
    if (failedStep) {
      const msg = buildRecoveryMessage({
        patchDir: relativePatchDir,
        failedStep,
        hasCommits: nonEmptyPatches.length > 0,
        hasDiff,
        hasUntracked,
      });
      console.error(`\n${msg}`);
    } else {
      yield* Effect.tryPromise({
        try: async () => {
          await rm(patchDir, { recursive: true, force: true });
          const patchesRoot = join(hostRepoDir, `.${ns}`, "patches");
          try {
            const remaining = await readdir(patchesRoot);
            if (remaining.length === 0) {
              await rm(join(hostRepoDir, `.${ns}`), {
                recursive: true,
                force: true,
              });
            }
          } catch {
            // ignore
          }
        },
        catch: () =>
          new SyncError({ message: "Failed to clean up patch directory" }),
      });
    }
  });
