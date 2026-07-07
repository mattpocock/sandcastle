---
"@ai-hero/sandcastle": patch
---

Fix Windows bind-mount worktree sandboxes being pruned as stale by overlaying the parent admin `gitdir` back-pointer with the sandbox worktree path.
