# Sync-out tracks its patch base in a sandbox-owned ref

## Context

For an **isolated sandbox provider**, `syncOut` extracts the agent's commits by
running `git format-patch "${base}..HEAD"` inside the **sandbox** and applying
the result on the **host** with `git am --3way` (`src/syncOut.ts`). `git am`
always re-commits, so every applied commit gets a new SHA on the host that
never existed in the sandbox.

The base was previously the host's `git rev-parse HEAD` (`syncOut.ts:171`). That
works for the first sync-out — right after sync-in, host and sandbox HEAD are
identical — but breaks on every subsequent sync-out against the same sandbox:
the host HEAD is now an `am`-rewritten SHA the sandbox has never seen, so
`format-patch` fails with `fatal: Invalid revision range`, aborting before any
recovery artifacts are saved. The whole run's commits are then lost when the
sandbox is torn down (issue #651).

## Decision

`syncOut` tracks the last-synced sandbox commit in a sandbox-owned ref,
`refs/sandcastle/sync-base`, kept entirely inside the sandbox's own git repo:

- **Resolve the base:** `git rev-parse --verify refs/sandcastle/sync-base` in
  the sandbox; if the ref is absent, fall back to the host's HEAD.
- **Advance the ref** to the sandbox's HEAD after the commit-application step
  succeeds — independent of whether the later uncommitted-diff or untracked-file
  steps fail. Commits that genuinely landed on the host must not be re-emitted
  on the next run.

The ref is absent **exactly when** no `git am` has run yet, and `git am` is the
only thing that rewrites host HEAD. So whenever the ref is missing, host HEAD
has not been rewritten and is therefore a valid base that still exists in the
sandbox. The two conditions are coupled, which is what makes the fallback safe.

The custom `refs/sandcastle/` namespace keeps the marker invisible to `git
log`, `git branch`, and `git tag`, and it never reaches the host: the
sandbox→host channel (`format-patch`/`am`) carries commits, not refs.

## Considered Options

1. **Host HEAD as the base** (previous behavior) — rejected. Poisoned by
   `git am`'s SHA rewrites on every run after the first.
2. **In-memory last-synced SHA on `IsolatedSandboxHandle`** — rejected. The
   handle has no state slot, and it leaks sync bookkeeping into the provider
   interface. A ref keeps everything inside `syncOut` and rides along in the
   sandbox's git repo, which already persists across runs.
3. **Collapse commits into a single `git diff base..HEAD` + `git apply`** —
   rejected. Sidesteps SHA rewrites but flattens history into one change and
   drops per-commit author/message metadata, which `syncOut` is tested to
   preserve.

## Consequences

- The same ref is read by `SandboxLifecycle` to compute the "Syncing N commits
  to host" count, which was previously also poisoned by host-HEAD on run 2+.
  The ref name lives in a single shared constant to avoid drift.
- Reversible in principle, but reverting the base to host HEAD silently
  reintroduces the data-loss bug — so the indirection is deliberate, not
  incidental.
