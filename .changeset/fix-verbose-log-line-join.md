---
"@ai-hero/sandcastle": patch
---

Fix verbose file logging: each raw JSON stream line now starts on its own line. Previously a raw line could be written onto the end of a line of agent text that had no trailing newline.
