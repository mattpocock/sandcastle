---
"@ai-hero/sandcastle": patch
---

Preserve structured output split across multiple assistant messages when an agent's final result repeats only the last message. Keep the complete text in `stdout` without duplicating the final snapshot, including when a hanging process reaches the completion timeout.
