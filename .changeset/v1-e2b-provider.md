---
"@ai-hero/sandcastle": minor
---

v1 (`@ai-hero/sandcastle/v1/sandboxes/e2b`): `e2b()`, a v1 provider factory for E2B sandboxes, beside `daytona()`. `e2b({ apiKey, domain, create })` takes E2B's own `Sandbox.create` options under `create` (typed `E2BCreateOptions`, without `envs`, `timeoutMs`, `lifecycle`, `apiKey` and `domain`, which Sandcastle sets). Sandboxes come from E2B's `claude` template by default, live for `timeLimitMinutes` and are killed (never paused) when it runs out, with the kill time read back from E2B. Env goes to each command, never to the sandbox. They're detachable: the session supervisor runs as a background command, and `reattachSandbox` connects without moving the kill time. See `docs/v1/e2b.md`.
