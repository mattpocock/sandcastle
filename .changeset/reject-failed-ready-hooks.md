---
"@ai-hero/sandcastle": patch
---

`createSandbox()` and `worktree.createSandbox()` now reject when a sandbox `onSandboxReady` hook exits non-zero, naming the command, its exit code and its stderr, and close the sandbox that just started. Before, a failed setup command (say, `npm ci`) was ignored and the sandbox came back as if setup had worked. Thanks @enwaiax!
