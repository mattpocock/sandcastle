---
"@ai-hero/sandcastle": patch
---

`run()`, `createSandbox()`, `createWorktree()` and `interactive()` now reject with the typed error (such as `ExecError` or `AgentError`) instead of an Effect `FiberFailure` wrapper. A failing `onSandboxReady` hook now reaches your script as an `ExecError` naming the command, its exit code and its stderr, rather than a long `(FiberFailure)` dump of Effect internals, and `instanceof` checks on the thrown error work.
