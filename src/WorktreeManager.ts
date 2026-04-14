import { Effect, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { WorktreeError } from "./errors.js";

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
 * When name is provided: `sandcastle/<sanitized-name>/<YYYYMMDD-HHMMSS>`.
 * Otherwise: `sandcastle/<YYYYMMDD-HHMMSS>`.
 */
export const generateTempBranchName = (name?: string): string => {
  const ts = formatTimestamp(new Date());
  if (name) {
    return `sandcastle/${sanitizeName(name)}/${ts}`;
  }
  return `sandcastle/${ts}`;
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
 * Fails with a clear error if the branch is already checked out in another worktree.
 */
export const create = (
  repoDir: string,
  opts?: {
    branch?: string;
    name?: string;
    /** When false, reuse an existing worktree instead of failing on collision. Default: true. */
    throwOnDuplicateWorktree?: boolean;
  },
): Effect.Effect<WorktreeInfo, WorktreeError, FileSystem.FileSystem> =>
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
      const timestamp = formatTimestamp(new Date());
      if (opts?.name) {
        const sanitized = sanitizeName(opts.name);
        branch = `sandcastle/${sanitized}/${timestamp}`;
        worktreeName = `sandcastle-${sanitized}-${timestamp}`;
      } else {
        branch = `sandcastle/${timestamp}`;
        worktreeName = `sandcastle-${timestamp}`;
      }
    }

    const worktreePath = join(worktreesDir, worktreeName);
    const existing = yield* listWorktrees(repoDir);
    const activeWorktreePaths = new Set(existing.map((wt) => wt.path));
    const hasOrphanedDir =
      (yield* fs
        .exists(worktreePath)
        .pipe(
          Effect.mapError((e) => new WorktreeError({ message: e.message })),
        )) && !activeWorktreePaths.has(worktreePath);

    if (hasOrphanedDir) {
      yield* fs.remove(worktreePath, { recursive: true, force: true }).pipe(
        Effect.mapError(
          (e) =>
            new WorktreeError({
              message: `Failed to remove orphaned worktree dir '${worktreePath}': ${e.message}`,
            }),
        ),
      );
    }

    if (opts?.branch) {
      // Proactively detect collision before git produces a confusing error
      const collision = existing.find((wt) => wt.branch === branch);
      if (collision) {
        if (opts.throwOnDuplicateWorktree === false) {
          return { path: collision.path, branch };
        }
        yield* Effect.fail(
          new WorktreeError({
            message:
              `Branch '${branch}' is already checked out in worktree at '${collision.path}'. ` +
              `Use a different branch name, or wait for the other run to finish.`,
          }),
        );
      }
      yield* execGit(["worktree", "add", worktreePath, branch], repoDir).pipe(
        Effect.catchAll((e) => {
          if (e.message.includes("invalid reference")) {
            return execGit(
              ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
              repoDir,
            );
          }
          return Effect.fail(e);
        }),
      );
    } else {
      yield* execGit(
        ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
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
  });

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
  const removeOnce = () =>
    execGit(["worktree", "remove", "--force", worktreePath], repoDir).pipe(
      Effect.asVoid,
    );

  return removeOnce().pipe(
    Effect.catchAll((error) => {
      if (!error.message.includes("Directory not empty")) {
        return Effect.fail(error);
      }

      return execGit(["clean", "-fdx"], worktreePath).pipe(
        Effect.andThen(removeOnce()),
      );
    }),
  );
};

/**
 * Prunes stale git worktree metadata and removes orphaned directories under
 * `.sandcastle/worktrees/`.
 */
export const pruneStale = (
  repoDir: string,
): Effect.Effect<void, WorktreeError, FileSystem.FileSystem> =>
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
      const entryPath = join(worktreesDir, entry);
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
  });
