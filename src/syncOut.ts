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
 *
 * Everything the sandbox reports (patch names, untracked paths, the symlinks
 * the patches make) is untrusted: `syncOutPaths.ts` checks that each host
 * destination stays inside the host worktree, and out of its `.git`, before
 * anything is written. A path that fails fails the sync with
 * `SyncOutPathError`; it is never skipped.
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
import { basename, dirname, join, relative } from "node:path";
import { Console, Effect } from "effect";
import type { ExecResult, SandboxService } from "./SandboxFactory.js";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { buildRecoveryMessage } from "./RecoveryMessage.js";
import type { FailedStep } from "./RecoveryMessage.js";
import { SyncError, type SyncOutPathError } from "./errors.js";
import { hostGit } from "./hostGit.js";
import {
  checkPatchFileSymlinks,
  checkPatchName,
  checkRelativePath,
  checkStagedFile,
  hostSymlinkAt,
  realRootOf,
  resolveHostDestination,
} from "./syncOutPaths.js";

/**
 * Sandbox-owned ref tracking the last-synced commit. Lives inside the sandbox's
 * git repo (not the host's), survives across `run()` calls on the same handle,
 * and never crosses to the host — sync-out ships commits, not refs. ADR 0017.
 */
export const SYNC_BASE_REF = "refs/sandcastle/sync-base";

/** Run host git, failing with SyncError on non-zero exit. */
const execHostGit = (
  args: readonly string[],
  cwd: string,
): Effect.Effect<string, SyncError> =>
  hostGit(args, cwd).pipe(
    Effect.mapError(
      (e) =>
        new SyncError({
          message: `Host command failed: git ${args.join(" ")}\n${e.message}`,
        }),
    ),
  );

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
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new SyncError({
              message: `Sandbox command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
            }),
          ),
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
      if (info.size === 0) {
        return true;
      }
      const content = await readFile(patchPath, "utf8");
      return !content.includes("diff --git");
    },
    catch: (e) =>
      new SyncError({
        message: `Failed to check patch ${patchPath}: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/** Removes a sync-out patch directory, and `.sandcastle/patches` once empty. */
const removePatchDir = (
  hostRepoDir: string,
  patchDir: string,
): Effect.Effect<void, SyncError> =>
  Effect.tryPromise({
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

const pad = (n: number) => String(n).padStart(2, "0");

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
): Effect.Effect<number> =>
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
    if (countResult.exitCode !== 0) {
      return 0;
    }
    const parsed = Number.parseInt(countResult.stdout.trim(), 10);
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
): Effect.Effect<void, SyncError | SyncOutPathError> => {
  let createdPatchDir: string | undefined;
  return Effect.gen(function* () {
    const { worktreePath } = handle;
    const realRoot = yield* realRootOf(hostRepoDir);

    const hostHead = (yield* execHostGit(
      ["rev-parse", "HEAD"],
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

    // Refuse a bad untracked path before anything is written.
    const untrackedSegments = yield* Effect.all(
      untrackedFiles.map((relPath) => checkRelativePath(relPath)),
    );

    // --- Phase 1: Save all artifacts ---
    const patchDir = yield* createPatchDir(hostRepoDir);
    createdPatchDir = patchDir;
    // Created with `mkdir -p`, which follows symlinks.
    yield* resolveHostDestination(realRoot, relative(hostRepoDir, patchDir));
    const relativePatchDir = join(".sandcastle", "patches", basename(patchDir));
    const untrackedDir = join(patchDir, "untracked");

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
          `git format-patch "${base}..HEAD" -o "${sandboxPatchDir}"`,
          { cwd: worktreePath },
        );

        const lsResult = yield* execOk(handle, `ls -1 "${sandboxPatchDir}"`);
        const patchNames = lsResult.stdout
          .trim()
          .split("\n")
          .filter((name) => name.length > 0);

        for (const patchName of patchNames) {
          yield* checkPatchName(patchName);
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
      for (const [i, relPath] of untrackedFiles.entries()) {
        const sandboxFilePath = `${worktreePath}/${relPath}`;
        const hostFilePath = join(
          untrackedDir,
          ...(untrackedSegments[i] ?? []),
        );
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

    // Each untracked file's host destination, symlinks resolved on the host.
    const checkUntrackedDestinations = () =>
      Effect.all(
        untrackedFiles.map((relPath, i) =>
          checkStagedFile(
            join(untrackedDir, ...(untrackedSegments[i] ?? [])),
            relPath,
          ).pipe(
            Effect.andThen(() => resolveHostDestination(realRoot, relPath)),
          ),
        ),
      );
    // Checked before anything is applied, and again just before writing.
    yield* checkUntrackedDestinations();

    // Refuse symlinks the patches would make that lead out of the worktree.
    yield* checkPatchFileSymlinks(
      [
        ...nonEmptyPatches,
        ...(hasDiff ? [join(patchDir, "changes.patch")] : []),
      ],
      hostSymlinkAt(realRoot),
    );

    // --- Phase 2: Apply from saved directory ---
    let failedStep: FailedStep | undefined;

    // Apply committed patches
    if (nonEmptyPatches.length > 0) {
      const abortResult = yield* Effect.either(
        execHostGit(["am", "--abort"], hostRepoDir),
      );
      void abortResult; // ignore abort failures
      const applyResult = yield* Effect.either(
        execHostGit(["am", "--3way", ...nonEmptyPatches], hostRepoDir),
      );
      if (applyResult._tag === "Left") {
        failedStep = "commits";
      }
    }

    // Apply uncommitted diff
    if (!failedStep && hasDiff) {
      const diffPath = join(patchDir, "changes.patch");
      const applyResult = yield* Effect.either(
        execHostGit(["apply", diffPath], hostRepoDir),
      );
      if (applyResult._tag === "Left") {
        failedStep = "diff";
      }
    }

    // Copy untracked files. The applied patches changed the host tree, so
    // each destination's symlinks are resolved again; a refusal fails the
    // sync rather than being recovered from.
    if (!failedStep && hasUntracked) {
      const destinations = yield* checkUntrackedDestinations();
      const copyResult = yield* Effect.either(
        Effect.tryPromise({
          try: async () => {
            for (const [i, destPath] of destinations.entries()) {
              const srcPath = join(
                untrackedDir,
                ...(untrackedSegments[i] ?? []),
              );
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
    // there were none new to ship in this slice). Skipped only when `git am`
    // itself failed — those commits never landed on the host, and the next
    // run must retry from the same base. Diff/untracked failures don't undo
    // the commits that already landed; the ref must move so we don't re-emit.
    if (hasCommits && failedStep !== "commits") {
      yield* execOk(handle, `git update-ref ${SYNC_BASE_REF} ${sandboxHead}`, {
        cwd: worktreePath,
      });
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
      yield* Console.error(`\n${msg}`);
    } else {
      yield* removePatchDir(hostRepoDir, patchDir);
    }
  }).pipe(
    // A refused path leaves nothing the sandbox wrote behind on the host.
    Effect.tapError((e) =>
      e._tag === "SyncOutPathError" && createdPatchDir !== undefined
        ? removePatchDir(hostRepoDir, createdPatchDir).pipe(Effect.ignore)
        : Effect.void,
    ),
  );
};
