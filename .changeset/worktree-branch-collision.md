---
"@ai-hero/sandcastle": patch
---

Refuse a branch whose worktree folder another branch already has, instead of silently running on that other branch. `feature/x` and `feature-x` both map to `.sandcastle/worktrees/feature-x/`; before, a run on `feature-x` reused `feature/x`'s worktree, so the agent committed to `feature/x` and `feature-x` was never created. Now that run fails with an error naming both branches. Thanks to @0x2AI for the report and the repro.
