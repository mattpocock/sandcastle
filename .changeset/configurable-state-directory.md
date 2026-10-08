---
"@ai-hero/sandcastle": minor
---

Add a `stateDir` option to `run()`, `interactive()`, `createSandbox()`, and `createWorktree()` to configure where Sandcastle reads/writes its gitignored runtime artifacts (`.env`, `worktrees/`, and the default `logs/`). Defaults to `.sandcastle`; relative paths resolve against the host repo directory, absolute paths are used verbatim. Useful when embedding Sandcastle under a higher-level tool that owns the per-repo directory name.
