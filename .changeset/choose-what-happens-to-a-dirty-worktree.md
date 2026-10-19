---
"@ai-hero/sandcastle": minor
---

`run()` and `createSandbox()` now accept `onUncommittedChanges`, which chooses what happens to the worktree when the run — or `close()` — ends with uncommitted changes still in it. `"preserve-worktree"` is the default and keeps today's behaviour exactly: the worktree is left on disk, its path is reported, and how to review or remove it is reported too. `"remove-worktree"` removes it anyway, leaving nothing on disk and reporting no preserved path.

Nothing changes for callers that do not pass the option, so this is a compatible addition rather than a breaking change. `"remove-worktree"` is for long-running unattended processes: a preserved worktree there is never reviewed, and it is never collected by the prune that runs before each new worktree — that prune only removes directories git no longer knows about, and a preserved worktree is still registered with git — so every run that ends dirty leaves a full copy of the repository behind for good.
