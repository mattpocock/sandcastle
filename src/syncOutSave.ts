// Phase 1 of sync-out: save every artifact to the patch directory, then check
// every path they would write on the host.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DateTime, Effect } from "effect";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { SyncError } from "./errors.js";
import type { SyncOutPathError } from "./errors.js";
import { execOk, execSandbox } from "./syncOutExec.js";
import type { SandboxChanges } from "./syncOutInspect.js";
import {
  checkPatchFileSymlinks,
  checkPatchName,
  checkStagedFile,
  hostSymlinkAt,
  resolveHostDestination,
} from "./syncOutPaths.js";

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
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Generate a YYYYMMDD-HHMMSS timestamp directory name.
 * Appends a counter suffix (-1, -2, ...) if the directory already exists.
 */
export const createPatchDir = (
  hostRepoDir: string,
): Effect.Effect<string, SyncError> =>
  DateTime.now.pipe(
    // Local time, as the directory name has always used.
    Effect.map((now) =>
      DateTime.toParts(DateTime.setZone(now, DateTime.zoneMakeLocal())),
    ),
    Effect.flatMap((now) =>
      Effect.tryPromise({
        try: async () => {
          const base = `${now.year}${pad(now.month)}${pad(now.day)}-${pad(now.hours)}${pad(now.minutes)}${pad(now.seconds)}`;

          const patchesRoot = join(hostRepoDir, ".sandcastle", "patches");
          await mkdir(patchesRoot, { recursive: true });

          const taken = new Set(await readdir(patchesRoot));
          let dirName = base;
          let counter = 0;
          while (taken.has(dirName)) {
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
      }),
    ),
  );
/** One sync-out, once its patch directory exists. */
export interface SyncRun {
  readonly hostRepoDir: string;
  readonly handle: IsolatedSandboxHandle;
  /** The host worktree's real path, symlinks resolved. */
  readonly realRoot: string;
  readonly changes: SandboxChanges;
  /** Each untracked file's checked path segments, by index. */
  readonly untrackedSegments: readonly string[][];
  readonly patchDir: string;
  readonly untrackedDir: string;
}

export const diffPathOf = (run: SyncRun): string =>
  join(run.patchDir, "changes.patch");

/** Where an untracked file is staged in the patch directory. */
export const stagedUntrackedPath = (run: SyncRun, i: number): string =>
  join(run.untrackedDir, ...(run.untrackedSegments[i] ?? []));
/**
 * Saves the sandbox's new commits as patches in the patch directory.
 * Returns the host paths of the patches that carry a diff.
 */
const saveCommitPatches = (
  run: SyncRun,
): Effect.Effect<string[], SyncError | SyncOutPathError> =>
  Effect.gen(function* () {
    const { handle } = run;
    const mkTempResult = yield* execOk(
      handle,
      "mktemp -d -t sandcastle-patches-XXXXXX",
    );
    const sandboxPatchDir = mkTempResult.stdout.trim();
    const nonEmptyPatches: string[] = [];

    try {
      yield* execOk(
        handle,
        `git format-patch "${run.changes.base}..HEAD" -o "${sandboxPatchDir}"`,
        { cwd: handle.worktreePath },
      );

      const lsResult = yield* execOk(handle, `ls -1 "${sandboxPatchDir}"`);
      const patchNames = lsResult.stdout
        .trim()
        .split("\n")
        .filter((name) => name.length > 0);

      for (const patchName of patchNames) {
        yield* checkPatchName(patchName);
        const sandboxPatchPath = `${sandboxPatchDir}/${patchName}`;
        const hostPatchPath = join(run.patchDir, patchName);
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
    return nonEmptyPatches;
  });

/** Saves the uncommitted diff as `changes.patch`. */
const saveDiff = (run: SyncRun): Effect.Effect<void, SyncError> =>
  Effect.tryPromise({
    try: () => writeFile(diffPathOf(run), run.changes.diff),
    catch: (e) =>
      new SyncError({
        message: `Failed to write diff patch: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/** Copies each untracked file out of the sandbox into the patch directory. */
const saveUntracked = (run: SyncRun): Effect.Effect<void, SyncError> =>
  Effect.gen(function* () {
    for (const [i, relPath] of run.changes.untrackedFiles.entries()) {
      const sandboxFilePath = `${run.handle.worktreePath}/${relPath}`;
      const hostFilePath = stagedUntrackedPath(run, i);
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(hostFilePath), { recursive: true });
          await run.handle.copyFileOut(sandboxFilePath, hostFilePath);
        },
        catch: (e) =>
          new SyncError({
            message: `Failed to save untracked file ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
    }
  });

/** Each untracked file's host destination, symlinks resolved on the host. */
export const checkUntrackedDestinations = (
  run: SyncRun,
): Effect.Effect<string[], SyncOutPathError> =>
  Effect.all(
    run.changes.untrackedFiles.map((relPath, i) =>
      checkStagedFile(stagedUntrackedPath(run, i), relPath).pipe(
        Effect.andThen(() => resolveHostDestination(run.realRoot, relPath)),
      ),
    ),
  );

/**
 * Phase 1: saves every artifact to the patch directory, then checks every
 * path they would write on the host. Returns the patches that carry a diff.
 */
export const saveAndCheck = (
  run: SyncRun,
): Effect.Effect<string[], SyncError | SyncOutPathError> =>
  Effect.gen(function* () {
    const { changes } = run;
    const nonEmptyPatches = changes.hasCommits
      ? yield* saveCommitPatches(run)
      : [];
    if (changes.hasDiff) {
      yield* saveDiff(run);
    }
    if (changes.hasUntracked) {
      yield* saveUntracked(run);
    }

    // Checked before anything is applied, and again just before writing.
    yield* checkUntrackedDestinations(run);

    // Refuse symlinks the patches would make that lead out of the worktree.
    yield* checkPatchFileSymlinks(
      [...nonEmptyPatches, ...(changes.hasDiff ? [diffPathOf(run)] : [])],
      hostSymlinkAt(run.realRoot),
    );
    return nonEmptyPatches;
  });
