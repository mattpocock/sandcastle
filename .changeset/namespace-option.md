---
"@ai-hero/sandcastle": patch
---

Add an optional `namespace` field on `RunOptions`, `CreateSandboxOptions`, and `CreateWorktreeOptions`. When set, it replaces the hardcoded `sandcastle` prefix used in the temporary branch ref (`<namespace>/<timestamp>`), worktree directory name (`<namespace>-<timestamp>`), worktree parent directory (`.<namespace>/worktrees/`), log directory (`.<namespace>/logs/`), patches directory (`.<namespace>/patches/`), and container / session names produced by the docker, podman, and daytona providers (`<namespace>-<uuid>`). Defaults to `"sandcastle"`, so existing behavior is unchanged. The `.sandcastle/.env` location is intentionally not affected. The namespace is forwarded to providers via a new optional field on `BindMountCreateOptions` and `IsolatedCreateOptions`; third-party providers can opt into reading it for their own naming.
