---
"@ai-hero/sandcastle": patch
---

`sandcastle init` now pins `@earendil-works/pi-coding-agent@1.5.2` in the scaffolded Dockerfile and in the host install hint, so a rebuild doesn't silently pick up a newer Pi release. Earlier builds clamped the output-token limit to 32000 (`Math.min(model.maxTokens, 32000)`), so a `maxTokens` in `~/.pi/agent/models.json` never reached the model and long turns ended with `stopReason` `length`.
