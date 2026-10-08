---
"@ai-hero/sandcastle": minor
---

The Claude Code stream parser now emits a `usage` event from the final `result` line, so runs without session capture (noSandbox, or when capture fails) still report token usage. When the session JSONL is captured, the session-parsed snapshot keeps precedence, so existing behavior is unchanged.
