---
"@ai-hero/sandcastle": patch
---

Security: with a bind-mount sandbox provider (`docker()`, `podman()`, or a custom `createBindMountSandboxProvider`), a sandboxed agent could make the git commands Sandcastle runs on the host execute code, outside the sandbox, through files it could write in the repo's `.git`. This is fixed. Sandcastle now mounts `.git/config`, `.git/hooks`, `.git/info`, the worktree's `.git` file and its `commondir` read-only in the sandbox, and every git command it runs on the host checks where the repo's `.git` leads and ignores repository hooks and program-running repository config (your global and system git config still applies). As a result, `git config` without `--global` now fails inside the sandbox, and host-side merges no longer run the repository's hooks. Isolated providers (`vercel()`, `daytona()`) were not affected. Thanks to the reporter of #1010.
