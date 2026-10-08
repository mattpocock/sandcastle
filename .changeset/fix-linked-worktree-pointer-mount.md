---
"@ai-hero/sandcastle": patch
---

Avoid redundant `.git` pointer mounts when starting bind-mount sandboxes from a linked Git worktree. Keep the shared repository metadata mount and the Windows overlay for the active sandbox workspace, without carrying the original checkout's pointer mount into the container.
