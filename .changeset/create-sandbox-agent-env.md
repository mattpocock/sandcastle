---
"@ai-hero/sandcastle": patch
---

`createSandbox()` and `worktree.createSandbox()` now pass the agent provider's `env` (e.g. `claudeCode(model, { env })`) to the agent on each `sandbox.run()`. It was silently dropped, because the container starts before an agent is chosen. The env is exported for that run's agent process only, and keys that overlap the sandbox provider's `env` are rejected, as in `run()`.
