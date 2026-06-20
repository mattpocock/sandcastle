---
"@ai-hero/sandcastle": minor
---

Bump default Claude Code model from `claude-opus-4-7` to `claude-opus-4-8`. The new default applies to the `DEFAULT_MODEL` constant, the `claude-code` agent entry surfaced by `sandcastle init`, and the scaffolded templates (`blank`, `parallel-planner`, `parallel-planner-with-review`). Passing an explicit model to `claudeCode(...)` is unaffected.
