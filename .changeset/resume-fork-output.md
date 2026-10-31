---
"@ai-hero/sandcastle": patch
---

`RunResult.resume()` and `.fork()` no longer inherit `output` from a structured-output run. Before, the follow-up re-ran the tag check against its new prompt and rejected with `output tag <…> not found in the resolved prompt` unless the prompt repeated the tag. Pass `output` to the follow-up to get structured output from it.
