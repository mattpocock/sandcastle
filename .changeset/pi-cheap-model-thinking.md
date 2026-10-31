---
"@ai-hero/sandcastle": patch
---

Document that `pi()` without `thinking` uses pi's own default (`medium`), which some models reject (e.g. `anthropic/claude-haiku-5-5` with pi 0.73.1), and that `{ thinking: "off" }` fixes it.
