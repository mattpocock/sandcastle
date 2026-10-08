---
"@ai-hero/sandcastle": patch
---

Stop concurrent bind-mount runs from deleting each other's worktrees.

With Docker/Podman, the worktree is bind-mounted at the container repo dir (e.g. `/home/agent/workspace`) while the shared `.git` is mounted host-identical. Each worktree's admin back-pointer (`.git/worktrees/<name>/gitdir`) therefore resolves to a host path that is NOT present in any *sibling* box's mount namespace, so `git worktree list` inside any box marks every sibling `prunable`. A `git worktree prune` run inside one box (directly or via tooling) then deletes all siblings' admin dirs from the shared `.git`, breaking live runs with `fatal: not a git repository: .git/worktrees/<name>` (mattpocock/sandcastle#849, #642).

Fix: create worktrees born-locked (`git worktree add --lock`); `git worktree prune` skips locked worktrees, so siblings survive regardless of what triggers the prune. Teardown (`remove`) now passes `--force` twice to override the lock. Worktree-mutating ops (`create`/`remove`/`pruneStale`) are also serialized through a single in-process permit to close the host-side birth-time `fs.remove` TOCTOU. Host-side `pruneStale` first unlocks worktrees whose directory is genuinely gone, so it still reclaims dead metadata while live siblings stay locked.
