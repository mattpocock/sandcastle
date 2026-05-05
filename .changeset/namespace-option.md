---
"@ai-hero/sandcastle": patch
---

Add an optional `namespace` field on `RunOptions`, `CreateSandboxOptions`, and `CreateWorktreeOptions`. When set, it replaces the hardcoded `sandcastle` prefix used in the temporary branch ref (`<namespace>/<timestamp>`), worktree directory name (`<namespace>-<timestamp>`), worktree parent directory (`.<namespace>/worktrees/`), log directory (`.<namespace>/logs/`), and patches directory (`.<namespace>/patches/`). Defaults to `"sandcastle"`, so existing behavior is unchanged. The `.sandcastle/.env` location is intentionally not affected.
