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
 * 2. Uncommitted changes (staged + unstaged): replace the previously synced
 *    `git diff --binary HEAD` with the current one using `git apply`
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
import type { ExecResult, SandboxService } from "./SandboxFactory.js";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { buildRecoveryMessage, type FailedStep } from "./RecoveryMessage.js";
import { SyncError } from "./errors.js";

/**
 * Sandbox-owned ref tracking the last-synced commit. Lives inside the sandbox's
 * git repo (not the host's), survives across `run()` calls on the same handle,
 * and never crosses to the host — sync-out ships commits, not refs. ADR 0017.
 */
export const SYNC_BASE_REF = "refs/sandcastle/sync-base";

/** Patch blob for the uncommitted changes currently applied on the host. */
const SYNC_DIFF_REF = "refs/sandcastle/sync-diff";

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
): Effect.Effect<string, SyncError> =>
  Effect.tryPromise({
    try: async () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

      const patchesRoot = join(hostRepoDir, ".sandcastle", "patches");
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
 * Count commits that `syncOut` would emit on the next run. Uses the same base
 * resolution as `syncOut` itself so the pre-flight count and the actual sync
 * stay in lockstep — SandboxLifecycle calls this to label "Syncing N commits
 * to host" without re-implementing the ref fallback.
 *
 * Degrades to 0 (rather than throwing) when either git command fails, matching
 * the prior inline behaviour at the call site. A missing sync-base ref is a
 * normal first-run state, so the rev-parse failure path falls back to hostHead.
 */
export const countCommitsToSync = (
  sandbox: SandboxService,
  cwd: string,
  hostHead: string,
): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const baseResult = yield* sandbox
      .exec(`git rev-parse --verify --quiet ${SYNC_BASE_REF}`, { cwd })
      .pipe(
        Effect.catchAll(() =>
          Effect.succeed<ExecResult>({
            stdout: "",
            stderr: "",
            exitCode: 1,
          }),
        ),
      );
    const base =
      baseResult.exitCode === 0 && baseResult.stdout.trim().length > 0
        ? baseResult.stdout.trim()
        : hostHead;
    const countResult = yield* sandbox
      .exec(`git rev-list "${base}..HEAD" --count`, { cwd })
      .pipe(
        Effect.catchAll(() =>
          Effect.succeed<ExecResult>({
            stdout: "0",
            stderr: "",
            exitCode: 1,
          }),
        ),
      );
    if (countResult.exitCode !== 0) return 0;
    const parsed = parseInt(countResult.stdout.trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });

/**
 * Sync changes from an isolated sandbox back to the host repo.
 *
 * Two-phase extraction with artifact persistence:
 * 1. Save all artifacts to `.sandcastle/patches/<timestamp>/`
 * 2. Apply from saved directory; on failure, preserve artifacts and print recovery
 */
export const syncOut = (
  hostRepoDir: string,
  handle: IsolatedSandboxHandle,
): Effect.Effect<void, SyncError> =>
  Effect.gen(function* () {
    const worktreePath = handle.worktreePath;

    const hostHead = (yield* execHost(
      "git rev-parse HEAD",
      hostRepoDir,
    )).trim();
    const sandboxHead = (yield* execOk(handle, "git rev-parse HEAD", {
      cwd: worktreePath,
    })).stdout.trim();

    // Resolve the format-patch base from a sandbox-owned ref. `git am` rewrites
    // host SHAs, so after run 1 the host HEAD is unknown to the sandbox; the
    // ref pins the last commit we actually shipped. Absent on run 1 — and that
    // is the only run where host HEAD is still a valid base (sync-in just
    // copied it in). The two conditions are coupled. See ADR 0017.
    const baseRefResult = yield* execSandbox(
      handle,
      `git rev-parse --verify --quiet ${SYNC_BASE_REF}`,
      { cwd: worktreePath },
    );
    const base =
      baseRefResult.exitCode === 0 && baseRefResult.stdout.trim().length > 0
        ? baseRefResult.stdout.trim()
        : hostHead;

    const hasCommits = base !== sandboxHead;

    // Keep the previous successful diff separately from the commit base. The
    // host still has those uncommitted changes, so applying another full HEAD
    // diff would reapply them (and git am would encounter a dirty worktree).
    const previousDiffRef = yield* execSandbox(
      handle,
      `git rev-parse --verify --quiet ${SYNC_DIFF_REF}`,
      { cwd: worktreePath },
    );
    const previousDiff =
      previousDiffRef.exitCode === 0
        ? (yield* execOk(handle, `git cat-file blob ${SYNC_DIFF_REF}`, {
            cwd: worktreePath,
          })).stdout
        : "";
    const diffResult = yield* execOk(handle, "git diff --binary HEAD", {
      cwd: worktreePath,
    });
    const replaceDiff = hasCommits || previousDiff !== diffResult.stdout;
    const hasPreviousDiff = replaceDiff && previousDiff.length > 0;
    const hasDiff = replaceDiff && diffResult.stdout.trim().length > 0;

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
    if (!hasCommits && !hasPreviousDiff && !hasDiff && !hasUntracked) {
      return;
    }

    // --- Phase 1: Save all artifacts ---
    const patchDir = yield* createPatchDir(hostRepoDir);
    const relativePatchDir = join(".sandcastle", "patches", basename(patchDir));

    const nonEmptyPatches: string[] = [];

    // Save the old diff too, before undoing anything on the host. On failure
    // both versions remain available alongside the usual recovery artifacts.
    if (hasPreviousDiff) {
      yield* Effect.tryPromise({
        try: () => writeFile(join(patchDir, "previous.diff"), previousDiff),
        catch: (e) =>
          new SyncError({
            message: `Failed to save previous diff: ${String(e)}`,
          }),
      });
    }

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
          `git format-patch "${base}..HEAD" -o "${sandboxPatchDir}"`,
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

    // Save uncommitted diff. Also store the snapshot as a Git blob, but only
    // point the tracking ref at it after the patch actually lands on the host.
    let diffBlob: string | undefined;
    if (hasDiff) {
      const diffPath = join(patchDir, "changes.patch");
      yield* Effect.tryPromise({
        try: () => writeFile(diffPath, diffResult.stdout),
        catch: (e) =>
          new SyncError({
            message: `Failed to write diff patch: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
      const snapshotPath = (yield* execOk(
        handle,
        "mktemp -t sandcastle-diff-XXXXXX",
      )).stdout.trim();
      try {
        // Hash the exact saved patch rather than running git diff again: the
        // marker must describe what was applied even if the sandbox changes.
        yield* Effect.tryPromise({
          try: () => handle.copyIn(diffPath, snapshotPath),
          catch: (e) =>
            new SyncError({
              message: `Failed to save diff snapshot: ${String(e)}`,
            }),
        });
        diffBlob = (yield* execOk(
          handle,
          `git hash-object -w "${snapshotPath}"`,
          { cwd: worktreePath },
        )).stdout.trim();
      } finally {
        yield* execSandbox(handle, `rm -f "${snapshotPath}"`);
      }
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

    // Undo only the patch Sandcastle previously applied. git apply is atomic
    // and refuses conflicting host edits; unrelated host changes survive.
    if (hasPreviousDiff) {
      const reverseResult = yield* Effect.either(
        execHost(
          `git apply --reverse "${join(patchDir, "previous.diff")}"`,
          hostRepoDir,
        ),
      );
      if (reverseResult._tag === "Left") {
        failedStep = "previousDiff";
      } else {
        yield* execOk(handle, `git update-ref -d ${SYNC_DIFF_REF}`, {
          cwd: worktreePath,
        });
      }
    }

    // Apply committed patches
    if (!failedStep && nonEmptyPatches.length > 0) {
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
      } else {
        yield* execOk(handle, `git update-ref ${SYNC_DIFF_REF} ${diffBlob!}`, {
          cwd: worktreePath,
        });
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

    // Advance the sync-base ref whenever commits were actually shipped (or
    // there were none new to ship in this slice). Skipped when reversing the
    // previous diff or `git am` failed — those commits never landed on the
    // host, and the next run must retry from the same base. Later failures don't undo
    // the commits that already landed; the ref must move so we don't re-emit.
    if (
      hasCommits &&
      failedStep !== "previousDiff" &&
      failedStep !== "commits"
    ) {
      yield* execOk(handle, `git update-ref ${SYNC_BASE_REF} ${sandboxHead}`, {
        cwd: worktreePath,
      });
    }

    // --- Cleanup or preserve ---
    if (failedStep) {
      const msg = buildRecoveryMessage({
        patchDir: relativePatchDir,
        failedStep,
        hasPreviousDiff,
        hasCommits: nonEmptyPatches.length > 0,
        hasDiff,
        hasUntracked,
      });
      console.error(`\n${msg}`);
    } else {
      yield* Effect.tryPromise({
        try: async () => {
          await rm(patchDir, { recursive: true, force: true });
          const patchesRoot = join(hostRepoDir, ".sandcastle", "patches");
          try {
            const remaining = await readdir(patchesRoot);
            if (remaining.length === 0) {
              await rm(patchesRoot, {
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
