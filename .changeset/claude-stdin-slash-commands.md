---
"@ai-hero/sandcastle": patch
---

Fix `claudeCode()` prompts that start with a slash command (`/code-review`, a user-invoked skill) never expanding. The print command ended in `-p -`, and Claude Code hands that `-` to the model as the first token of the prompt, so the slash command was no longer at the start. The prompt is still delivered on stdin; only the trailing `-p -` is dropped (`--print` is already passed).
