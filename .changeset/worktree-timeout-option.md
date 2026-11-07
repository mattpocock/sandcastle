---
"@ai-hero/sandcastle": patch
---

Add `timeouts.worktreeMs` to raise the 30-second limit on creating the git worktree (and pruning stale ones first), for large working trees on slow storage. The timeout error reports the limit in effect.
