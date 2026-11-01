---
"@ai-hero/sandcastle": patch
---

Fix `{{TARGET_BRANCH}}` under `createWorktree()`: `wt.run()` and `wt.interactive()` now set it to the host's current branch, as `run()` and `interactive()` do, instead of the worktree's own branch.
