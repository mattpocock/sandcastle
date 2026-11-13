---
"@ai-hero/sandcastle": patch
---

A run that finished no longer rejects when sandcastle then fails to remove its worktree (for instance one already deregistered by `git worktree prune` inside the sandbox). The result, with its output, commits and session id, is returned; the worktree is kept, a warning says where, and its path is in `preservedWorktreePath`.
