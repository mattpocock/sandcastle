---
"@ai-hero/sandcastle": patch
---

Add `claudeCodeVertex` agent provider for running Claude Code through Google Vertex AI. Accepts `region` (required) and `projectId` (optional) as routing config; Google credentials are supplied via the sandbox environment (`GOOGLE_APPLICATION_CREDENTIALS` or Application Default Credentials). The `model` argument is passed to `claude --model` and must match a model ID enabled in your project's Vertex AI Model Garden — these IDs often need a dated suffix (e.g. `claude-opus-4-1@20250805`). Supports `effort`, `captureSessions`, and session resume — identical behaviour to `claudeCode`.
