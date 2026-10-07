---
"@ai-hero/sandcastle": patch
---

Fix Windows worktree-mode sandbox creation when the host repo is itself a linked git worktree. Git mounts are now resolved from the worktree Sandcastle mounts into the sandbox rather than from the host repo directory, so `hostRepoDir/.git` (a pointer file whose identity mount Docker rejects on Windows) is no longer emitted. The parent `.git` directory still resolves identically.
