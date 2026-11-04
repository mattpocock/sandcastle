/**
 * The sandbox lifecycle's git steps on the host: reading the host's branch
 * and identity before the work, then collecting commits and the temp-branch
 * merge into the host's checked-out branch after it.
 */
import { Effect } from "effect";
import { Display } from "./Display.js";
import {
  CommitCollectionTimeoutError,
  MergeToHostTimeoutError,
  SyncError,
  withTimeout,
} from "./errors.js";
import type { ExecError } from "./errors.js";
import { hostGit } from "./hostGit.js";
import type { SandboxService } from "./SandboxFactory.js";
import { execOk } from "./sandboxSetup.js";

/**
 * Without an explicit branch, the host's current branch, which the work is
 * merged back into; `null` when there is an explicit branch.
 */
export const readHostCurrentBranch = (options: {
  readonly branch?: string;
  readonly hostRepoDir: string;
}): Effect.Effect<string | null> =>
  options.branch !== undefined && options.branch !== ""
    ? Effect.succeed(null)
    : hostGit(["rev-parse", "--abbrev-ref", "HEAD"], options.hostRepoDir).pipe(
        Effect.map((stdout) => stdout.trim()),
        Effect.orDie,
      );

/** The host's git identity; a field git has no value for is "". */
export const readHostIdentity = (
  hostRepoDir: string,
): Effect.Effect<{ name: string; email: string }> => {
  const readIdentity = (key: string) =>
    hostGit(["config", key], hostRepoDir).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.orElseSucceed(() => ""),
    );
  return Effect.all([readIdentity("user.name"), readIdentity("user.email")], {
    concurrency: "unbounded",
  }).pipe(Effect.map(([name, email]) => ({ name, email })));
};

/** The commits in `range`, oldest first; none when git fails. */
const collectCommits = (
  range: readonly string[],
  hostRepoDir: string,
): Effect.Effect<{ sha: string }[]> =>
  hostGit(["rev-list", ...range, "--reverse"], hostRepoDir).pipe(
    Effect.map((stdout) => {
      const lines = stdout.trim();
      return lines === "" ? [] : lines.split("\n").map((sha) => ({ sha }));
    }),
    Effect.orElseSucceed(() => []),
  );

/**
 * Merges `sourceBranch` into the host's checked-out `targetBranch`. On
 * failure, aborts a merge that started so the host is left as it was, and
 * fails with a message saying how to retry.
 */
const mergeToHost = (
  sourceBranch: string,
  targetBranch: string,
  hostRepoDir: string,
): Effect.Effect<void, SyncError> =>
  // `--`: the branch name comes from the sandbox.
  hostGit(["merge", "--", sourceBranch], hostRepoDir).pipe(
    Effect.asVoid,
    Effect.catchAll((e) =>
      Effect.gen(function* () {
        const gitOutput = [e.stdout, e.stderr]
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .join("\n");
        // Don't leave the host mid-merge (MERGE_HEAD set, conflict markers in
        // the working tree): if the merge started, abort it so the host is as
        // it was and the retry below starts clean.
        const mergeStarted = yield* hostGit(
          ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
          hostRepoDir,
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (mergeStarted) {
          yield* hostGit(["merge", "--abort"], hostRepoDir).pipe(Effect.ignore);
        }
        return yield* new SyncError({
          message:
            `Merge of '${sourceBranch}' onto '${targetBranch}' failed${
              mergeStarted ? " and was aborted" : ""
            }, so '${targetBranch}' is unchanged.${
              gitOutput === "" ? " " : `\ngit merge said:\n${gitOutput}\n`
            }The temporary branch '${sourceBranch}' has been preserved. ` +
            `To retry: git merge ${sourceBranch} (resolve any conflicts and commit), ` +
            `then clean up: git branch -D ${sourceBranch}`,
        });
      }),
    ),
  );

/** Collects the commits in `range` on the host, under a timeout. */
export const collectCommitsLogged = (
  range: string,
  hostRepoDir: string,
  timeoutMs: number,
): Effect.Effect<{ sha: string }[], CommitCollectionTimeoutError, Display> =>
  Effect.gen(function* () {
    const display = yield* Display;
    return yield* display.taskLog("Collecting commits", () =>
      collectCommits([range], hostRepoDir).pipe(
        withTimeout(
          timeoutMs,
          () =>
            new CommitCollectionTimeoutError({
              message: `Commit collection timed out after ${timeoutMs}ms`,
              timeoutMs,
            }),
        ),
      ),
    );
  });

export interface TempBranchMerge {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly hostRepoDir: string;
  /** Keep the temp branch checked out and undeleted (createWorktree's
   *  merge-to-head path). */
  readonly keepSourceBranch: boolean;
  readonly mergeToHostTimeoutMs: number;
  /** Whether the temp branch has commits to merge. */
  readonly hasNewCommits: boolean;
  readonly tempBranch: string;
  readonly hostBranch: string;
}

const mergeToHostWithTimeout = (
  merge: TempBranchMerge,
): Effect.Effect<void, SyncError | MergeToHostTimeoutError> =>
  mergeToHost(merge.tempBranch, merge.hostBranch, merge.hostRepoDir).pipe(
    withTimeout(
      merge.mergeToHostTimeoutMs,
      () =>
        new MergeToHostTimeoutError({
          message: `Merge of '${merge.tempBranch}' to '${merge.hostBranch}' timed out after ${merge.mergeToHostTimeoutMs}ms`,
          timeoutMs: merge.mergeToHostTimeoutMs,
          sourceBranch: merge.tempBranch,
          targetBranch: merge.hostBranch,
        }),
    ),
  );

/**
 * Temp branch mode: merges the temp branch into the host branch, then
 * deletes the temp branch.
 *
 * We use merge instead of cherry-pick because cherry-pick breaks when the
 * temp branch contains merge commits (e.g. a merge agent merging multiple parallel
 * branches). A regular merge handles both the fast-forward case (host branch hasn't
 * moved) and the diverged case (host branch has new commits since the worktree started).
 */
export const mergeTempBranch = (
  merge: TempBranchMerge,
): Effect.Effect<
  void,
  ExecError | SyncError | MergeToHostTimeoutError,
  Display
> =>
  Effect.gen(function* () {
    const display = yield* Display;

    // Detach the worktree from the temp branch so the branch can be deleted.
    // Skipped when `keepSourceBranch` is set (createWorktree's merge-to-head
    // path) so the worktree stays on its source branch for re-use.
    if (!merge.keepSourceBranch) {
      yield* execOk(merge.sandbox, "git checkout --detach", {
        cwd: merge.sandboxRepoDir,
      });
    }

    if (merge.hasNewCommits) {
      // Fast-forward host's current branch to the temp branch
      yield* display.taskLog(`Merging to ${merge.hostBranch}`, () =>
        mergeToHostWithTimeout(merge),
      );
    }

    // Delete the temp branch (now merged into host branch). Skipped when
    // `keepSourceBranch` is set: the source branch is the worktree's active
    // branch and the worktree's lifetime outlives the lifecycle.
    if (!merge.keepSourceBranch) {
      yield* hostGit(
        ["branch", "-D", "--", merge.tempBranch],
        merge.hostRepoDir,
      ).pipe(Effect.ignore);
    }
  });
