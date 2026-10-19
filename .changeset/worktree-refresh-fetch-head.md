---
"@ai-hero/sandcastle": patch
---

Fix clean worktree reuse failing to refresh when a shallow/single-branch clone or custom fetch refspec leaves the remote-tracking branch missing or stale. Fast-forward to the branch tip actually fetched from origin, and distinguish the requested branch from tags with the same name.
