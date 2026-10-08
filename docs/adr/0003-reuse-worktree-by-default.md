# Reuse existing worktree by default

## Context

When the **branch** strategy is used, the caller supplies a named branch and Sandcastle creates a worktree at `.sandcastle/worktrees/<name>/`. If a worktree for that branch already exists on disk (e.g. because the user re-ran the same command), the previous behaviour was to throw, with an opt-out via `throwOnDuplicateWorktree: false` that silently returned the existing worktree.

Throw-by-default made the common "re-run the same command" case fail loudly, and the opt-out was unsafe — it silently handed the agent whatever arbitrary state happened to be in the worktree, including uncommitted work from a prior run that could be clobbered.

A reused worktree also holds a **local copy** of the branch that does not move on its own. In a re-run loop — e.g. an agent reviews a branch, a developer pushes fixes to `origin`, the script runs again — the second run reads the _stale_ local branch, not the updated `origin/<branch>`. The reuse looks correct but operates on old code, which is confusing and easy to miss (issue #606).

The naive fix ("if there are no uncommitted changes, pull from origin") is unsafe. A worktree can be clean of uncommitted changes yet still hold **unpushed commits** — the branch strategy's whole purpose is that the agent's commits land on the named branch in the worktree. A `git reset --hard origin/<branch>` (or any non-fast-forward refresh) would silently destroy that work.

## Decision

Remove `throwOnDuplicateWorktree` from `run()`, `createSandbox()`, `SandboxFactory`, and `WorktreeManager.create`. Replace with a single built-in behaviour:

- **Clean worktree** (no staged, unstaged, or untracked changes) → reuse it, and emit one `console.log` line so the user knows the starting state wasn't fresh.
- **Dirty worktree** → reuse it, and emit a warning so the user knows the worktree has uncommitted changes. The agent starts with whatever state is there.

"Dirty" is defined narrowly as uncommitted changes.

On the **reuse path**, Sandcastle additionally **fast-forwards the worktree from `origin` when, and only when, it is safe**:

- `git fetch origin refs/heads/<branch>`, then `git merge --ff-only FETCH_HEAD`.
- The refresh runs **only** when the worktree is clean (no uncommitted changes) **and** the local branch is strictly behind the fetched branch tip (a fast-forward is possible).
- If the worktree is **dirty**, or the branch has **diverged** (unpushed commits — not fast-forwardable), or the **fetch fails** (e.g. offline), the refresh is skipped, the worktree is reused as-is, and Sandcastle logs why. A failed fetch is non-fatal; it never breaks the run.

This refresh is the **default** — there is no opt-in flag. The only behaviour it changes versus pure reuse is "a clean, strictly-behind worktree now fast-forwards," which is the obviously-correct outcome; every case where reuse-as-is matters (unpushed commits, uncommitted work) is explicitly left untouched. Unpushed commits and branch drift against origin still do not count as "dirty" — they are normal for a long-lived named branch, and a diverged branch is reused exactly as it was.

The merge target is the tip just fetched into `FETCH_HEAD`. A single-branch
clone (including the default for `--depth 1`) can have a fetch refspec that
updates only `origin/main`; fetching another branch still succeeds but leaves
`origin/<branch>` absent or stale. Custom refspecs can also store the fetched
branch in a different namespace. As documented in [git-fetch](https://git-scm.com/docs/git-fetch#_configured_remote_tracking_branches),
an explicit source determines what is fetched while the configured refspec
determines which tracking refs are updated. Using `FETCH_HEAD` works with those
mappings without changing the caller's configuration. The fully qualified
source also disambiguates branches from tags with the same name. A failed
fetch still returns before the merge, so an earlier `FETCH_HEAD` is never used.

The rejected alternatives:

- Keep the `throwOnDuplicateWorktree` boolean and flip the default. The name then reads backwards from the default, and the unsafe "reuse even when dirty" path remains reachable.
- Replace with an enum (`onDuplicateWorktree: "reuse" | "throw"`). Adds a knob with no concrete use case for `"throw"` once the dirty-guard exists.
- Make the origin refresh opt-in (`refreshFromRemote: true`). A clean, strictly-behind worktree has no reason to stay behind, so the flag would be a tax everyone pays to get the correct behaviour. Rejected in favour of a safe default.
- Refresh with `git reset --hard origin/<branch>` (match origin unconditionally). Clobbers unpushed commits. Rejected; `--ff-only` is the safe equivalent.

## Scope

- **Reuse only.** First creation is unaffected — there is nothing stale yet, and the caller is already responsible for the base ref's currency (see `SandboxProvider`'s `baseBranch` contract).
- **Branch strategy only.** The **merge-to-head** strategy uses fresh timestamped branches per run with no `origin` counterpart (collisions are impossible, the refresh is a no-op); the **head** strategy has no worktree.
- **`origin`**, no config knob. The remote is hardcoded for now; a configuration option can be added if a real need appears.

## Consequences

- Breaking change to the public API on `run()`, `createSandbox()`, and `SandboxFactory`. Pre-1.0, shipped as a `patch` changeset.
- Re-running the same command is now the happy path — no stale-worktree errors when the prior run left the tree clean.
- Re-run loops (review-then-fix, iterate-then-rerun) pick up upstream changes automatically when the worktree is clean, without the caller wiring up a manual `git pull` hook.
- Dirty worktrees are reused with a warning — no manual cleanup required to re-run. This trades safety (possible clobbering of in-progress work) for convenience. Worktree locking (#401) is a future mitigation for the concurrent-access risk this opens up.
- Unpushed commits and uncommitted work are never clobbered — a diverged or dirty worktree is reused exactly as it was, with a log line explaining why no refresh happened.
- `createSandbox` / `createWorktree` now perform a network fetch on reuse. This adds latency and a dependency on remote reachability, both handled by treating fetch failure as a non-fatal skip.
- Only the **branch** strategy is affected in practice. The **merge-to-head** strategy uses fresh timestamped branches per run, so collisions were already impossible there.
