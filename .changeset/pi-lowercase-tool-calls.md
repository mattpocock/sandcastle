---
"@ai-hero/sandcastle": patch
---

Show pi's tool calls in the run log again. Pi names its built-in tools in lowercase (`bash`), which the parser's case-sensitive allowlist dropped, so no `Bash(...)` line appeared and the prose either side of a tool call ran together.
