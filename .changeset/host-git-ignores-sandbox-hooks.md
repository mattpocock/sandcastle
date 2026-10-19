---
"@ai-hero/sandcastle": patch
---

Sandcastle's own host-side git commands (worktree creation, status checks, merging the branch back) now run with git hooks and `core.fsmonitor` disabled. Previously, an agent could write a hook or fsmonitor command into the shared `.git` from inside a worktree sandbox and have it execute on the host, outside the container.
