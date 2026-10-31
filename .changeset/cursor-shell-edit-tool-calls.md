---
"@ai-hero/sandcastle": patch
---

Show cursor's tool calls in the run log again. Current Cursor CLIs report shell commands as `shellToolCall` and file writes as `editToolCall`, which the parser didn't know, so a cursor run showed prose only. They now display as `Bash(<command>)` and `Edit(<path>)`.
