---
"@ai-hero/sandcastle": minor
---

Capture subagent and workflow session logs from the Claude Code sandbox to the host alongside the main session transcript.

Previously, logs written by `Agent`-tool subagents and `Workflow` runs were lost on sandbox teardown. They are now copied out with the same `cwd` path rewrite applied. Capture is best-effort: a corrupt or unreadable subagent log is skipped with a warning rather than aborting the rest of the capture.
