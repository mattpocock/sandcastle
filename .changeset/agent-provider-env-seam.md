---
"@ai-hero/sandcastle": patch
---

Fix `agentProviderEnv` being silently dropped in `createSandboxFromWorktree` and `createSandbox`. Both call sites hardcoded `agentProviderEnv: {}` when building the container env via `mergeProviderEnv`, discarding any per-provider environment variables passed through `CreateSandboxOptions.agentProviderEnv` / `WorktreeCreateSandboxOptions.agentProviderEnv` (e.g. API keys, base URLs, provider-selection flags an `AgentProvider` wants injected). `agentProviderEnv` is now a proper option on `CreateSandboxOptions`, `CreateSandboxFromWorktreeOptions`, and `WorktreeCreateSandboxOptions`, wired through to `mergeProviderEnv` at both sites, matching the four call sites in `run.ts` / `interactive.ts` / `createWorktree.ts` that already correctly pass `provider.env`.
