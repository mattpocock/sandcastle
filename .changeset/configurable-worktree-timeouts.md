---
"@ai-hero/sandcastle": minor
---

Add `timeouts.worktreeCreateMs` and `timeouts.worktreePruneMs` to configure host-side worktree creation/reuse and stale-worktree cleanup. Both retain the 30-second default and are supported by `run()`, `interactive()`, `createSandbox()`, and `createWorktree()`.
