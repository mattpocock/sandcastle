---
"@ai-hero/sandcastle": patch
---

Add an optional `vcs` option to `run()`, `interactive()`, `createSandbox()`, and `createWorktree()`. Defaults to `git()`, which preserves all existing behavior. The new `VersionControlProvider` interface is the seam through which alternative VCS backends (such as Jujutsu, in a follow-up release) can be implemented.

This change is a pure refactor — no observable behavior changes for existing callers.
