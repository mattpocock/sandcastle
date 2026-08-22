---
"@ai-hero/sandcastle": patch
---

Reject `createSandbox()` and `worktree.createSandbox()` when a sandbox `onSandboxReady` hook exits with a non-zero status.