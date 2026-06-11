---
"@ai-hero/sandcastle": minor
---

Add MiniMax agent provider. Adds `minimax` as a new sandcastle agent that calls the MiniMax Anthropic-compatible API via OAuth. The agent runs in a sandbox container using a CLI wrapper that streams JSON events in sandcastle's expected format. Configure via `MINIMAX_ACCESS_TOKEN` and `MINIMAX_REFRESH_TOKEN` environment variables.