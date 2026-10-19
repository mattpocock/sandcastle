import { Effect, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, normalize } from "node:path";
import { WorktreeError, WorktreeTimeoutError, withTimeout } from "./errors.js";

const WORKTREE_TIMEOUT_MS = 30_000;

/**
 * Serializes every worktree-mutating git op (`create` → `git worktree add`,
 * `remove` → `git worktree remove`, `pruneStale` → `git worktree prune` +
 * orphan sweep) through a single in-process permit.
 *
 * `git worktree` add/remove/prune mutate the SHARED `.git/worktrees/` admin tree
 * and are NOT safe to run concurrently on one repo. When parallel callers (e.g.
 * several `createSandbox()` runs, or a dispose racing a sibling's create) overlap,
 * one caller's `prune` treats another's in-flight `add` as stale and deletes its
 * admin dir, breaking that sibling mid-run (mattpocock/sandcastle#849, #642).
 *
 * The guarded ops are milliseconds long, so serializing them costs ~zero
 * wall-clock. The expensive onSandboxReady hooks (e.g. dependency install) run
 * OUTSIDE this lock in createSandbox(), so concurrency there is preserved.
 */
const worktreeMutationLock = Effect.unsafeMakeSemaphore(1);

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

/**
 * Short random hex suffix appended to generated temp branch names. Three
 * bytes (six hex chars) is enough entropy to keep concurrent `run()` /
 * `RunResult.fork()` calls within the same second from colliding on branch
 * names — the second-granularity timestamp alone is not (see ADR 0018).
 */
const randomBranchSuffix = (): string => randomBytes(3).toString("hex");

/** Sanitize a name for use in branch names and directory names. */
export const sanitizeName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "-");

const execGit = (
  args: string[],
  cwd: string,
): Effect.Effect<string, WorktreeError> =>
  Effect.async((resume) => {
    // Force the C locale so git emits English, machine-stable messages. Several
    // callers match git's stderr (e.g. "invalid reference") to decide control
    // flow; under a localized locale gettext translates those strings and the
    // matches silently fail, breaking worktree creation (issue #595).
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout, stderr) => {
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
      },
    );
  });

/**
 * Generates a temporary branch name.
 * When name is provided: `sandcastle/<sanitized-name>/<YYYYMMDD-HHMMSS>-<random>`.
 * Otherwise: `sandcastle/<YYYYMMDD-HHMMSS>-<random>`.
 *
 * The random suffix prevents collisions between concurrent calls within the
 * same wall-clock second — relevant for fan-out via `RunResult.fork()` and
 * for plain `Promise.all([run(), run()])` callers.
 */
export const generateTempBranchName = (name?: string): string => {
  const ts = formatTimestamp(new Date());
  const suffix = randomBranchSuffix();
  if (name) {
    return `sandcastle/${sanitizeName(name)}/${ts}-${suffix}`;
  }
  return `sandcastle/${ts}-${suffix}`;
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

/** A single entry parsed from `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string;
  /** `null` for a detached HEAD (e.g. mid-rebase). */
  branch: string | null;
}

/**
 * Normalizes path separators to forward slashes.
 *
 * `git worktree list --porcelain` reports paths with forward slashes on every
 * platform, but `node:path.join` produces backslashes on Windows. Comparing
 * the two without normalizing fails on Windows, so all path comparisons in
 * this module run both sides through this first.
 */
const normalizePath = (p: string): string => p.replace(/\\/g, "/");

/**
 * Finds an existing worktree that collides with `branch` or `worktreePath`.
 *
 * Matches by branch first, then falls back to a path match — covering the
 * mid-rebase detached-HEAD case where git reports a `null` branch. The path
 * fallback normalizes separators so it works on Windows.
 */
export const findCollidingWorktree = (
  existing: readonly WorktreeEntry[],
  branch: string,
  worktreePath: string,
): WorktreeEntry | undefined =>
  existing.find((wt) => wt.branch === branch) ??
  existing.find((wt) => normalizePath(wt.path) === normalizePath(worktreePath));

/**
 * Whether `worktreePath` lives under `worktreesDir` (i.e. is a worktree managed
 * by sandcastle rather than the main working tree or an external worktree).
 * Separators are normalized so the check holds on Windows.
 */
export const isManagedWorktreePath = (
  worktreePath: string,
  worktreesDir: string,
): boolean =>
  normalizePath(worktreePath).startsWith(normalizePath(worktreesDir));

/**
 * Whether a directory entry under `.sandcastle/worktrees/` is orphaned — not
 * present in the set of active worktree paths reported by git. Both sides are
 * normalized so paths from `join` (backslashes on Windows) match git's
 * forward-slash output.
 */
export const isOrphanedWorktreePath = (
  entryPath: string,
  activeWorktreePaths: Iterable<string>,
): boolean => {
  const normalizedEntry = normalizePath(entryPath);
  for (const active of activeWorktreePaths) {
    if (normalizePath(active) === normalizedEntry) return false;
  }
  return true;
};

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
 * On the clean-reuse path, fetches `origin/<branch>` into the worktree and
 * fast-forwards local HEAD. Skipped silently (with an explanatory log) when:
 *
 * - HEAD is not attached to `<branch>` — a mid-rebase worktree paused at an
 *   `edit`/`exec`/`break` instruction has a clean working tree but a detached
 *   HEAD pointing at the pause point. `git merge --ff-only` there would
 *   silently advance HEAD past the pause and break `git rebase --continue`;
 * - the fetch fails (no `origin`, unreachable network, branch missing on
 *   origin) — the worktree is reused as-is, never breaking the run; or
 * - the local branch has diverged from `origin/<branch>` (unpushed commits +
 *   moved origin), in which case `--ff-only` refuses and the unpushed work
 *   is preserved exactly as it was.
 *
 * Errors here are non-fatal by design (ADR 0003): the worst case is the same
 * stale-but-usable worktree the caller would have had before this refresh
 * existed.
 */
const fastForwardFromOrigin = (
  worktreePath: string,
  branch: string,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    // `symbolic-ref --quiet HEAD` exits non-zero when HEAD is detached;
    // map both failure and an unexpected target to "" so the predicate
    // below treats them the same as "not on this branch".
    const headRef = yield* execGit(
      ["symbolic-ref", "--quiet", "HEAD"],
      worktreePath,
    ).pipe(
      Effect.map((s) => s.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (headRef !== `refs/heads/${branch}`) {
      console.log(
        `Reusing worktree at ${worktreePath} (branch '${branch}') — HEAD is not on '${branch}', skipping origin refresh`,
      );
      return;
    }
    const fetchResult = yield* Effect.either(
      execGit(
        [...NO_CONFIG_LOCK_FLAGS, "fetch", "origin", branch],
        worktreePath,
      ),
    );
    if (fetchResult._tag === "Left") {
      console.log(
        `Could not fetch from origin (reusing worktree at ${worktreePath} as-is, branch '${branch}')`,
      );
      return;
    }
    const before = yield* execGit(["rev-parse", "HEAD"], worktreePath).pipe(
      Effect.map((s) => s.trim()),
      Effect.orElseSucceed(() => ""),
    );
    const mergeResult = yield* Effect.either(
      execGit(
        [...NO_CONFIG_LOCK_FLAGS, "merge", "--ff-only", `origin/${branch}`],
        worktreePath,
      ),
    );
    if (mergeResult._tag === "Left") {
      console.log(
        `Branch '${branch}' has diverged from origin (reusing worktree at ${worktreePath} as-is)`,
      );
      return;
    }
    const after = yield* execGit(["rev-parse", "HEAD"], worktreePath).pipe(
      Effect.map((s) => s.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (before && after && before !== after) {
      console.log(
        `Fast-forwarded worktree at ${worktreePath} (branch '${branch}') to origin/${branch}`,
      );
    } else {
      console.log(
        `Reusing existing worktree at ${worktreePath} (branch '${branch}')`,
      );
    }
  });

/**
 * Creates a git worktree at `.sandcastle/worktrees/<name>/`.
 *
 * - If `branch` is specified, checks out that branch.
 * - If not, creates a temporary `sandcastle/<timestamp>` branch.
 *
 * When `branch` collides with an existing managed worktree:
 * - Clean → reuses the existing worktree and fast-forwards it from
 *   `origin/<branch>` when it is strictly behind (ADR 0003). A failed fetch
 *   or a diverged branch is non-fatal and falls back to plain reuse.
 * - Dirty (uncommitted changes) → reuses with a console warning, no refresh.
 *
 * Collisions with the main working tree or external worktrees always throw.
 */
export const create = (
  repoDir: string,
  opts?: {
    branch?: string;
    baseBranch?: string;
    name?: string;
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
      const timestamp = formatTimestamp(new Date());
      const suffix = randomBranchSuffix();
      if (opts?.name) {
        const sanitized = sanitizeName(opts.name);
        branch = `sandcastle/${sanitized}/${timestamp}-${suffix}`;
        worktreeName = `sandcastle-${sanitized}-${timestamp}-${suffix}`;
      } else {
        branch = `sandcastle/${timestamp}-${suffix}`;
        worktreeName = `sandcastle-${timestamp}-${suffix}`;
      }
    }

    const worktreePath = join(worktreesDir, worktreeName);

    if (opts?.branch) {
      // Proactively detect collision before git produces a confusing error.
      // Match by branch first; fall back to target path (covers mid-rebase
      // detached-HEAD state where the branch field is null).
      const existing = yield* listWorktrees(repoDir);
      const collision = findCollidingWorktree(existing, branch, worktreePath);
      if (collision) {
        // Only reuse worktrees managed by sandcastle (under .sandcastle/worktrees/)
        if (isManagedWorktreePath(collision.path, worktreesDir)) {
          const dirty = yield* hasUncommittedChanges(collision.path);
          if (dirty) {
            console.warn(
              `Reusing worktree at ${collision.path} (branch '${branch}') — worktree has uncommitted changes`,
            );
          } else {
            yield* fastForwardFromOrigin(collision.path, branch);
          }
          // Ensure a reused worktree is locked too (born-locked covers fresh
          // adds; reuse bypasses that). Best-effort: ignore "already locked".
          yield* execGit(["worktree", "lock", collision.path], repoDir).pipe(
            Effect.catchAll(() => Effect.void),
          );
          // git reports forward slashes even on Windows; return a
          // platform-native path so downstream join/fs calls stay consistent.
          return { path: normalize(collision.path), branch };
        }
        // Branch is checked out in the main working tree or external worktree
        yield* Effect.fail(
          new WorktreeError({
            message:
              `Branch '${branch}' is already checked out in worktree at '${collision.path}'. ` +
              `Sandcastle's branch and merge-to-head strategies run the agent in a git worktree under .sandcastle/worktrees/, ` +
              `and git refuses to check out the same branch in two worktrees at once (HEAD would become ambiguous). ` +
              `Pick a different branch, or switch the main working tree to a different branch before re-running.`,
          }),
        );
      }
      // `--lock` makes the worktree born locked: with bind-mount providers the
      // worktree is mounted at a container path (e.g. /home/agent/workspace)
      // while the shared `.git` is mounted host-identical, so the admin
      // back-pointer resolves to a path NOT present in any sibling's container.
      // A `git worktree prune` run inside ANY concurrent box (or its tooling)
      // would otherwise see every sibling as "gitdir points to non-existent
      // location" and delete it from the shared `.git`, killing live runs
      // (mattpocock/sandcastle#849). A locked worktree is skipped by prune.
      yield* execGit(
        [
          ...NO_CONFIG_LOCK_FLAGS,
          "worktree",
          "add",
          "--lock",
          worktreePath,
          branch,
        ],
        repoDir,
      ).pipe(
        Effect.catchAll((e) => {
          if (e.message.includes("invalid reference")) {
            return execGit(
              [
                ...NO_CONFIG_LOCK_FLAGS,
                "worktree",
                "add",
                "--lock",
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
          "--lock",
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
    worktreeMutationLock.withPermits(1),
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
  // Worktrees are created `--lock`ed (see create); a single `--force` refuses a
  // locked worktree ("use 'remove -f -f' to override or unlock first"), so pass
  // it twice to tear down regardless of lock state.
  return execGit(
    ["worktree", "remove", "--force", "--force", worktreePath],
    repoDir,
  ).pipe(Effect.asVoid, worktreeMutationLock.withPermits(1));
};

/**
 * Unlocks worktrees that are locked but whose directory is genuinely gone, so
 * the `git worktree prune` below can reclaim them.
 *
 * Worktrees are born locked (see `create`) so that a `git worktree prune` run
 * from inside a sibling container cannot delete them. The cost is that prune
 * also stops reclaiming worktrees that really are dead, e.g. after a crash
 * deleted the directory. Unlocking those first restores that.
 *
 * Absence on disk is a safe signal *here* specifically because `pruneStale`
 * runs host-side, where a live sibling's directory does exist. The failure this
 * lock defends against is a raw `git worktree prune` inside a container, where
 * siblings only *look* absent; that path never reaches this function.
 */
const unlockDeadWorktrees = (
  repoDir: string,
): Effect.Effect<void, WorktreeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const list = yield* execGit(["worktree", "list", "--porcelain"], repoDir);

    // Porcelain output is blank-line separated records, each starting with
    // `worktree <path>`; a locked worktree carries a `locked` line.
    for (const record of list.split("\n\n")) {
      const lines = record.split("\n");
      const path = lines
        .find((line) => line.startsWith("worktree "))
        ?.slice("worktree ".length)
        .trim();
      if (!path) continue;
      if (
        !lines.some((line) => line === "locked" || line.startsWith("locked "))
      )
        continue;

      const stillThere = yield* fs
        .exists(path)
        .pipe(Effect.catchAll(() => Effect.succeed(true)));
      if (stillThere) continue;

      yield* execGit(["worktree", "unlock", path], repoDir).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }
  });

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

    // Let git clean up metadata for worktrees whose directories are gone.
    // Born-locked worktrees are skipped by prune, so release the dead ones
    // first; live siblings stay locked and survive.
    yield* unlockDeadWorktrees(repoDir);
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
      if (isDir && isOrphanedWorktreePath(entryPath, activeWorktreePaths)) {
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
    worktreeMutationLock.withPermits(1),
  );
