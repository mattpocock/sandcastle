import { Effect, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { WorktreeError, WorktreeTimeoutError, withTimeout } from "./errors.js";

const WORKTREE_TIMEOUT_MS = 30_000;

/**
 * Git global flags that prevent `git worktree add -b` from writing upstream
 * tracking config to `.git/config`. Without these, a user's global
 * `branch.autoSetupMerge` or `push.autoSetupRemote` can cause a config write
 * that races with other processes holding `.git/config.lock`.
 */
const NO_CONFIG_LOCK_FLAGS = [
  "-c",
  "branch.autoSetupMerge=false",
  "-c",
  "push.autoSetupRemote=false",
];

/** Format a timestamp as YYYYMMDD-HHMMSS */
const formatTimestamp = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
};

/** Sanitize a name for use in branch names and directory names. */
export const sanitizeName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "-");

/** Sanitize a run id for use in branch names and directory names. */
const sanitizeRunId = (runId: string): string =>
  runId.replace(/[^A-Za-z0-9._-]/g, "-");

const execGit = (
  args: string[],
  cwd: string,
): Effect.Effect<string, WorktreeError> =>
  Effect.async((resume) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        resume(
          Effect.fail(
            new WorktreeError({
              message: stderr?.trim() || error.message,
            }),
          ),
        );
      } else {
        resume(Effect.succeed(stdout));
      }
    });
  });

/**
 * Generates a temporary branch name.
 * When runId is provided: `sandcastle/<runId>`.
 * When name and runId are provided: `sandcastle/<sanitized-name>/<runId>`.
 *
 * @deprecated Omitting runId falls back to timestamp-only branch names for
 * compatibility. New concurrent callers should pass runId to avoid collisions.
 */
export const generateTempBranchName = (
  name?: string,
  runId?: string,
): string => {
  const suffix = runId ? sanitizeRunId(runId) : formatTimestamp(new Date());
  if (name) {
    return `sandcastle/${sanitizeName(name)}/${suffix}`;
  }
  return `sandcastle/${suffix}`;
};

/** Returns the name of the currently checked-out branch in the given repo directory. */
export const getCurrentBranch = (
  repoDir: string,
): Effect.Effect<string, WorktreeError> =>
  execGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).pipe(
    Effect.map((output) => output.trim()),
  );

export interface WorktreeInfo {
  path: string;
  branch: string;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/** Parses `git worktree list --porcelain` output into structured entries. */
const listWorktrees = (
  repoDir: string,
): Effect.Effect<WorktreeEntry[], WorktreeError> =>
  execGit(["worktree", "list", "--porcelain"], repoDir).pipe(
    Effect.map((output) => {
      const entries: WorktreeEntry[] = [];
      let currentPath: string | null = null;
      let currentBranch: string | null = null;

      for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (currentPath !== null) {
            entries.push({ path: currentPath, branch: currentBranch });
          }
          currentPath = line.slice("worktree ".length).trim();
          currentBranch = null;
        } else if (line.startsWith("branch ")) {
          // "branch refs/heads/my-branch" -> "my-branch"
          currentBranch = line.slice("branch refs/heads/".length).trim();
        }
      }

      if (currentPath !== null) {
        entries.push({ path: currentPath, branch: currentBranch });
      }

      return entries;
    }),
  );

/**
 * Creates a git worktree at `.sandcastle/worktrees/<name>/`.
 *
 * - If `branch` is specified, checks out that branch.
 * - If not, creates a temporary `sandcastle/<timestamp>` branch.
 *
 * When `branch` collides with an existing managed worktree:
 * - Clean → reuses the existing worktree.
 * - Dirty (uncommitted changes) → reuses with a console warning (ADR 0003).
 *
 * Collisions with the main working tree or external worktrees always throw.
 */
export const create = (
  repoDir: string,
  opts?: {
    branch?: string;
    baseBranch?: string;
    name?: string;
    /**
     * Unique run id to use for temporary branch/worktree names.
     *
     * @deprecated Omitting runId falls back to timestamp-only names for
     * compatibility. New concurrent callers should pass runId.
     */
    runId?: string;
  },
): Effect.Effect<
  WorktreeInfo,
  WorktreeError | WorktreeTimeoutError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const worktreesDir = join(repoDir, ".sandcastle", "worktrees");
    yield* fs
      .makeDirectory(worktreesDir, { recursive: true })
      .pipe(Effect.mapError((e) => new WorktreeError({ message: e.message })));

    let branch: string;
    let worktreeName: string;

    if (opts?.branch) {
      branch = opts.branch;
      worktreeName = branch.replace(/\//g, "-");
    } else {
      const suffix = opts?.runId
        ? sanitizeRunId(opts.runId)
        : formatTimestamp(new Date());
      if (opts?.name) {
        const sanitized = sanitizeName(opts.name);
        branch = `sandcastle/${sanitized}/${suffix}`;
        worktreeName = `sandcastle-${sanitized}-${suffix}`;
      } else {
        branch = `sandcastle/${suffix}`;
        worktreeName = `sandcastle-${suffix}`;
      }
    }

    const worktreePath = join(worktreesDir, worktreeName);

    if (opts?.branch) {
      // Proactively detect collision before git produces a confusing error.
      // Match by branch first; fall back to target path (covers mid-rebase
      // detached-HEAD state where the branch field is null).
      const existing = yield* listWorktrees(repoDir);
      const collision =
        existing.find((wt) => wt.branch === branch) ??
        existing.find((wt) => wt.path === worktreePath);
      if (collision) {
        // Only reuse worktrees managed by sandcastle (under .sandcastle/worktrees/)
        const isManagedWorktree = collision.path.startsWith(worktreesDir);
        if (isManagedWorktree) {
          const dirty = yield* hasUncommittedChanges(collision.path);
          if (dirty) {
            console.warn(
              `Reusing worktree at ${collision.path} (branch '${branch}') — worktree has uncommitted changes`,
            );
          } else {
            console.log(
              `Reusing existing worktree at ${collision.path} (branch '${branch}')`,
            );
          }
          return { path: collision.path, branch };
        }
        // Branch is checked out in the main working tree or external worktree
        yield* Effect.fail(
          new WorktreeError({
            message:
              `Branch '${branch}' is already checked out in worktree at '${collision.path}'. ` +
              `Use a different branch name, or wait for the other run to finish.`,
          }),
        );
      }
      yield* execGit(
        [...NO_CONFIG_LOCK_FLAGS, "worktree", "add", worktreePath, branch],
        repoDir,
      ).pipe(
        Effect.catchAll((e) => {
          if (e.message.includes("invalid reference")) {
            return execGit(
              [
                ...NO_CONFIG_LOCK_FLAGS,
                "worktree",
                "add",
                "-b",
                branch,
                worktreePath,
                opts?.baseBranch ?? "HEAD",
              ],
              repoDir,
            );
          }
          return Effect.fail(e);
        }),
      );
    } else {
      yield* execGit(
        [
          ...NO_CONFIG_LOCK_FLAGS,
          "worktree",
          "add",
          "-b",
          branch,
          worktreePath,
          "HEAD",
        ],
        repoDir,
      ).pipe(
        Effect.catchAll((e) => {
          if (
            e.message.includes("already checked out") ||
            e.message.includes("already exists")
          ) {
            return Effect.fail(
              new WorktreeError({
                message:
                  `Branch '${branch}' is already checked out in another worktree. ` +
                  `Use a different branch name, or wait for the other run to finish.`,
              }),
            );
          }
          return Effect.fail(e);
        }),
      );
    }

    return { path: worktreePath, branch };
  }).pipe(
    withTimeout(
      WORKTREE_TIMEOUT_MS,
      () =>
        new WorktreeTimeoutError({
          message: `Worktree creation timed out after ${WORKTREE_TIMEOUT_MS}ms`,
          timeoutMs: WORKTREE_TIMEOUT_MS,
          path: repoDir,
          operation: "create",
        }),
    ),
  );

/**
 * Returns true if the worktree at `worktreePath` has any uncommitted changes:
 * unstaged modifications, staged changes, or untracked files.
 */
export const hasUncommittedChanges = (
  worktreePath: string,
): Effect.Effect<boolean, WorktreeError> =>
  execGit(["status", "--porcelain"], worktreePath).pipe(
    Effect.map((output) => output.trim().length > 0),
  );

/**
 * Removes a worktree and its git metadata.
 *
 * The `worktreePath` must be a path inside `.sandcastle/worktrees/` so that
 * the main repository directory can be derived from it.
 */
export const remove = (
  worktreePath: string,
): Effect.Effect<void, WorktreeError> => {
  // Derive the main repo dir: worktreePath = <repoDir>/.sandcastle/worktrees/<name>
  const repoDir = join(worktreePath, "..", "..", "..");
  return execGit(["worktree", "remove", "--force", worktreePath], repoDir).pipe(
    Effect.asVoid,
  );
};

/**
 * Prunes stale git worktree metadata and removes orphaned directories under
 * `.sandcastle/worktrees/`.
 */
export const pruneStale = (
  repoDir: string,
): Effect.Effect<
  void,
  WorktreeError | WorktreeTimeoutError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    // Let git clean up metadata for worktrees whose directories are gone
    yield* execGit(["worktree", "prune"], repoDir);

    const worktreesDir = join(repoDir, ".sandcastle", "worktrees");

    // Read directory entries — return null if directory doesn't exist
    const entries: string[] | null = yield* fs.readDirectory(worktreesDir).pipe(
      Effect.map((es): string[] | null => es),
      Effect.catchSome((e) =>
        e._tag === "SystemError" && e.reason === "NotFound"
          ? Option.some(Effect.succeed(null as string[] | null))
          : Option.none(),
      ),
      Effect.mapError((e) => new WorktreeError({ message: e.message })),
    );

    if (entries === null) return;

    // `git worktree list` canonicalizes paths via realpath. If repoDir or
    // .sandcastle is a symlink, joining the un-canonicalized prefix produces
    // strings that never match git's output, and every active worktree looks
    // orphaned. Resolve the prefix once so the Set lookup below works.
    const realWorktreesDir = yield* fs
      .realPath(worktreesDir)
      .pipe(Effect.catchAll(() => Effect.succeed(worktreesDir)));

    // Get the list of active worktree paths from git
    const worktreeList = yield* execGit(
      ["worktree", "list", "--porcelain"],
      repoDir,
    );
    const activeWorktreePaths = new Set(
      worktreeList
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim()),
    );

    // Remove any directory under .sandcastle/worktrees/ that is not an active worktree
    for (const entry of entries) {
      const entryPath = join(realWorktreesDir, entry);
      const isDir = yield* fs.stat(entryPath).pipe(
        Effect.map((s) => s.type === "Directory"),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      if (isDir && !activeWorktreePaths.has(entryPath)) {
        yield* fs.remove(entryPath, { recursive: true, force: true }).pipe(
          Effect.mapError(
            (e) =>
              new WorktreeError({
                message: `Failed to remove ${entryPath}: ${e.message}`,
              }),
          ),
        );
      }
    }
  }).pipe(
    withTimeout(
      WORKTREE_TIMEOUT_MS,
      () =>
        new WorktreeTimeoutError({
          message: `Worktree prune timed out after ${WORKTREE_TIMEOUT_MS}ms`,
          timeoutMs: WORKTREE_TIMEOUT_MS,
          path: repoDir,
          operation: "prune",
        }),
    ),
  );
