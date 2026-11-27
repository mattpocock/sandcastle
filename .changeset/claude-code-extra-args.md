---
"@ai-hero/sandcastle": minor
---

Add an `extraArgs` option to `claudeCode()` that appends raw CLI flags to the `claude` invocation, as an escape hatch for flags Sandcastle doesn't model yet (e.g. `--strict-mcp-config`, `--mcp-config`, `--settings`).
