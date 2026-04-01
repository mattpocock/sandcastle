---
"@ai-hero/sandcastle": patch
---

Add Codex CLI as a supported agent provider

- Added `codexProvider` for the [Codex CLI](https://github.com/openai/codex) (`@openai/codex`)
- Codex uses `--json` JSONL output format with `item.completed`, `item.started`, and `turn.completed` events
- Default model: `gpt-5.4-mini`
- Requires `OPENAI_API_KEY` environment variable
