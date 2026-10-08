---
"@ai-hero/sandcastle": patch
---

Fix repeated isolated sandbox runs failing to sync uncommitted changes. Track the last successfully applied diff, remove it before applying the next run's commits and changes, and preserve recovery artifacts when host edits conflict. Support binary diffs without modifying the sandbox's index or commit history.
