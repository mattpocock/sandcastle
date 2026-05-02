---
"@ai-hero/sandcastle": patch
---

Fix generated Docker and Podman Sandcastle configs for Codex auth. `sandcastle init` now lets Codex users choose API-key auth or subscription auth, keeps API-key auth as the default, and generates subscription auth by mounting only `~/.codex/auth.json` read-only before copying it into a writable sandbox-local `CODEX_HOME`.

Generated templates now share a sandbox config across all run/createSandbox calls and set `GIT_CONFIG_GLOBAL` inside `.sandcastle/` so Git global config writes do not fail when Docker runs with a host UID that does not own `/home/agent`.
