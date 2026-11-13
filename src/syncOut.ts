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

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { Console, Effect } from "effect";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { buildRecoveryMessage } from "./RecoveryMessage.js";
import type { FailedStep } from "./RecoveryMessage.js";
import { SyncError } from "./errors.js";
import type { SyncOutPathError } from "./errors.js";
import {
  checkRelativePath,
  realRootOf,
  resolveHostDestination,
} from "./syncOutPaths.js";
import { execHostGit, execOk } from "./syncOutExec.js";
import { SYNC_BASE_REF, inspectSandbox } from "./syncOutInspect.js";
import type { SyncRun } from "./syncOutSave.js";
import {
  checkUntrackedDestinations,
  createPatchDir,
  diffPathOf,
  saveAndCheck,
  stagedUntrackedPath,
} from "./syncOutSave.js";

export { SYNC_BASE_REF, countCommitsToSync } from "./syncOutInspect.js";

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
/** Copies the staged untracked files to their checked host destinations. */
const copyUntrackedToHost = (
  run: SyncRun,
  destinations: readonly string[],
): Effect.Effect<void, SyncError> =>
  Effect.tryPromise({
    try: async () => {
      for (const [i, destPath] of destinations.entries()) {
        const srcPath = stagedUntrackedPath(run, i);
        await mkdir(dirname(destPath), { recursive: true });
        const content = await readFile(srcPath);
        await writeFile(destPath, content);
      }
    },
    catch: (e) =>
      new SyncError({
        message: `Failed to copy untracked files: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/** Whether `effect` failed, without failing. */
const failed = <E>(effect: Effect.Effect<unknown, E>): Effect.Effect<boolean> =>
  Effect.either(effect).pipe(Effect.map((result) => result._tag === "Left"));

/**
 * Phase 2: applies the saved artifacts to the host, in order, stopping at
 * the first step that fails. Returns that step.
 */
const applySaved = (
  run: SyncRun,
  nonEmptyPatches: readonly string[],
): Effect.Effect<FailedStep | undefined, SyncOutPathError> =>
  Effect.gen(function* () {
    const { hostRepoDir, changes } = run;
    // Apply committed patches
    if (nonEmptyPatches.length > 0) {
      // ignore abort failures
      yield* Effect.either(execHostGit(["am", "--abort"], hostRepoDir));
      if (
        yield* failed(
          execHostGit(["am", "--3way", ...nonEmptyPatches], hostRepoDir),
        )
      ) {
        return "commits";
      }
    }

    // Apply uncommitted diff
    if (
      changes.hasDiff &&
      (yield* failed(execHostGit(["apply", diffPathOf(run)], hostRepoDir)))
    ) {
      return "diff";
    }

    // Copy untracked files. The applied patches changed the host tree, so
    // each destination's symlinks are resolved again; a refusal fails the
    // sync rather than being recovered from.
    if (changes.hasUntracked) {
      const destinations = yield* checkUntrackedDestinations(run);
      if (yield* failed(copyUntrackedToHost(run, destinations))) {
        return "untracked";
      }
    }
    return undefined;
  });

/**
 * Advances the sync-base ref, then cleans up the patch directory, or keeps
 * it and prints how to recover when a step failed.
 */
const completeSyncOut = (
  run: SyncRun,
  nonEmptyPatches: readonly string[],
  failedStep: FailedStep | undefined,
): Effect.Effect<void, SyncError> =>
  Effect.gen(function* () {
    const { changes } = run;
    // Advance the sync-base ref whenever commits were actually shipped (or
    // there were none new to ship in this slice). Skipped only when `git am`
    // itself failed — those commits never landed on the host, and the next
    // run must retry from the same base. Diff/untracked failures don't undo
    // the commits that already landed; the ref must move so we don't re-emit.
    if (changes.hasCommits && failedStep !== "commits") {
      yield* execOk(
        run.handle,
        `git update-ref ${SYNC_BASE_REF} ${changes.sandboxHead}`,
        { cwd: run.handle.worktreePath },
      );
    }

    // --- Cleanup or preserve ---
    if (failedStep) {
      const msg = buildRecoveryMessage({
        patchDir: join(".sandcastle", "patches", basename(run.patchDir)),
        failedStep,
        hasCommits: nonEmptyPatches.length > 0,
        hasDiff: changes.hasDiff,
        hasUntracked: changes.hasUntracked,
      });
      yield* Console.error(`\n${msg}`);
    } else {
      yield* removePatchDir(run.hostRepoDir, run.patchDir);
    }
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
    const realRoot = yield* realRootOf(hostRepoDir);
    const changes = yield* inspectSandbox(hostRepoDir, handle);

    // Nothing to sync
    if (!changes.hasCommits && !changes.hasDiff && !changes.hasUntracked) {
      return;
    }

    // Refuse a bad untracked path before anything is written.
    const untrackedSegments = yield* Effect.all(
      changes.untrackedFiles.map((relPath) => checkRelativePath(relPath)),
    );

    // --- Phase 1: Save all artifacts ---
    const patchDir = yield* createPatchDir(hostRepoDir);
    createdPatchDir = patchDir;
    // Created with `mkdir -p`, which follows symlinks.
    yield* resolveHostDestination(realRoot, relative(hostRepoDir, patchDir));
    const run: SyncRun = {
      hostRepoDir,
      handle,
      realRoot,
      changes,
      untrackedSegments,
      patchDir,
      untrackedDir: join(patchDir, "untracked"),
    };
    const nonEmptyPatches = yield* saveAndCheck(run);

    // --- Phase 2: Apply from saved directory ---
    const failedStep = yield* applySaved(run, nonEmptyPatches);
    yield* completeSyncOut(run, nonEmptyPatches, failedStep);
  }).pipe(
    // A refused path leaves nothing the sandbox wrote behind on the host.
    Effect.tapError((e) =>
      e._tag === "SyncOutPathError" && createdPatchDir !== undefined
        ? removePatchDir(hostRepoDir, createdPatchDir).pipe(Effect.ignore)
        : Effect.void,
    ),
  );
};
