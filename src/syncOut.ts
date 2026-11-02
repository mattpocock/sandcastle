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
import { Console, DateTime, Effect } from "effect";
import type { ExecResult, SandboxService } from "./SandboxFactory.js";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { buildRecoveryMessage } from "./RecoveryMessage.js";
import type { FailedStep } from "./RecoveryMessage.js";
import { SyncError } from "./errors.js";
import type { SyncOutPathError } from "./errors.js";
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
      }),
    ),
  );

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

/** What the sandbox has that the host doesn't. */
interface SandboxChanges {
  /** The commit format-patch starts from. */
  readonly base: string;
  readonly sandboxHead: string;
  readonly hasCommits: boolean;
  readonly hasDiff: boolean;
  /** `git diff HEAD` in the sandbox: the uncommitted changes. */
  readonly diff: string;
  readonly hasUntracked: boolean;
  readonly untrackedFiles: string[];
}

/**
 * The format-patch base, from a sandbox-owned ref. `git am` rewrites host
 * SHAs, so after run 1 the host HEAD is unknown to the sandbox; the ref pins
 * the last commit we actually shipped. Absent on run 1 — and that is the only
 * run where host HEAD is still a valid base (sync-in just copied it in). The
 * two conditions are coupled. See ADR 0017.
 */
const readSyncBase = (
  handle: IsolatedSandboxHandle,
  hostHead: string,
): Effect.Effect<string, SyncError> =>
  execSandbox(handle, `git rev-parse --verify --quiet ${SYNC_BASE_REF}`, {
    cwd: handle.worktreePath,
  }).pipe(
    Effect.map((result) =>
      result.exitCode === 0 && result.stdout.trim().length > 0
        ? result.stdout.trim()
        : hostHead,
    ),
  );

/** The sandbox's untracked files; none when git fails. */
const listUntracked = (
  handle: IsolatedSandboxHandle,
): Effect.Effect<string[], SyncError> =>
  execSandbox(handle, "git ls-files --others --exclude-standard", {
    cwd: handle.worktreePath,
  }).pipe(
    Effect.map((result) =>
      result.exitCode === 0 && result.stdout.trim().length > 0
        ? result.stdout
            .trim()
            .split("\n")
            .filter((f) => f.length > 0)
        : [],
    ),
  );

/** Asks the sandbox what changed since the last sync. */
const inspectSandbox = (
  hostRepoDir: string,
  handle: IsolatedSandboxHandle,
): Effect.Effect<SandboxChanges, SyncError> =>
  Effect.gen(function* () {
    const hostHead = (yield* execHostGit(
      ["rev-parse", "HEAD"],
      hostRepoDir,
    )).trim();
    const sandboxHead = (yield* execOk(handle, "git rev-parse HEAD", {
      cwd: handle.worktreePath,
    })).stdout.trim();
    const base = yield* readSyncBase(handle, hostHead);

    // Check for uncommitted changes
    const diffResult = yield* execSandbox(handle, "git diff HEAD", {
      cwd: handle.worktreePath,
    });
    const untrackedFiles = yield* listUntracked(handle);

    return {
      base,
      sandboxHead,
      hasCommits: base !== sandboxHead,
      hasDiff: diffResult.exitCode === 0 && diffResult.stdout.trim().length > 0,
      diff: diffResult.stdout,
      hasUntracked: untrackedFiles.length > 0,
      untrackedFiles,
    };
  });

/** One sync-out, once its patch directory exists. */
interface SyncRun {
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

const diffPathOf = (run: SyncRun): string =>
  join(run.patchDir, "changes.patch");

/** Where an untracked file is staged in the patch directory. */
const stagedUntrackedPath = (run: SyncRun, i: number): string =>
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
const checkUntrackedDestinations = (
  run: SyncRun,
): Effect.Effect<string[], SyncOutPathError> =>
  Effect.all(
    run.changes.untrackedFiles.map((relPath, i) =>
      checkStagedFile(stagedUntrackedPath(run, i), relPath).pipe(
        Effect.andThen(() => resolveHostDestination(run.realRoot, relPath)),
      ),
    ),
  );

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
 * Phase 1: saves every artifact to the patch directory, then checks every
 * path they would write on the host. Returns the patches that carry a diff.
 */
const saveAndCheck = (
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
