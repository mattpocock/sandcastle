---
"@ai-hero/sandcastle": minor
---

Add role configuration schema version 2: each role can select any supported
agent provider (codex, claudeCode, pi, opencode, copilot, cursor) with a
capability-checked effort and an ordered fallback chain of up to three targets.
Version 1 files keep working unchanged; `migrateRoleConfig` converts explicitly.
The runtime builds each role's configured provider (`agent`), exposes the frozen
setting (`roleSetting`) and fallback chain (`agentChain`), and accepts
per-provider project options under `options.providers`. The operator web edits
provider, model, effort and fallback per role.

The engine falls back to the next configured provider only for classified
provider failures (rate limit, unavailable, authentication, missing CLI, model
unavailable, startup timeout) before any tool call, never after the agent has
acted. Iteration results and Agent Map record every provider attempt and the
provider that actually ran. Role-configured providers run with other
providers' agent credential variables unset.
