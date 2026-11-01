---
"@ai-hero/sandcastle": patch
---

`run()` now keeps its worktree when interrupted, as the `signal` docs say. Aborting via `signal` no longer removes a clean worktree; it prints where the worktree is kept. On SIGINT/SIGTERM, `run()` now prints the kept worktree's path and cleanup command, as `createSandbox()` already did, instead of leaving it behind silently.
