// What sync-out reads from the sandbox: the sync-base ref, and what changed
// since the last sync.

import { Effect } from "effect";
import type { ExecResult, SandboxService } from "./SandboxFactory.js";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import type { SyncError } from "./errors.js";
import { execHostGit, execOk, execSandbox } from "./syncOutExec.js";

/**
 * Sandbox-owned ref tracking the last-synced commit. Lives inside the sandbox's
 * git repo (not the host's), survives across `run()` calls on the same handle,
 * and never crosses to the host — sync-out ships commits, not refs. ADR 0017.
 */
export const SYNC_BASE_REF = "refs/sandcastle/sync-base";
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
    const parsed = Number(countResult.stdout.trim());
    return Number.isInteger(parsed) ? parsed : 0;
  });

/** What the sandbox has that the host doesn't. */
export interface SandboxChanges {
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
export const inspectSandbox = (
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
