---
"@ai-hero/sandcastle": minor
---

v1 (`@ai-hero/sandcastle/v1`): add `modal()`, a Modal provider factory at `@ai-hero/sandcastle/v1/sandboxes/modal`. Its sandboxes are detachable, so `detach()`, `reattachSandbox` and `status()` work on them. Each sandbox's Modal lifetime comes from `timeLimitMinutes` (at most 24 hours), and its kill time is kept in a file in the sandbox so a reattached handle reports it too. The default image is `node:24-bookworm` with Claude Code and a non-root `sandcastle` user: commands run as that user (root with `sudo: true`), so Claude Code runs without `IS_SANDBOX`. `create` takes `modal`'s own `sandboxes.create` params, without `timeoutMs`, `idleTimeoutMs`, `env` and `secrets`. See `docs/v1/modal.md`.
