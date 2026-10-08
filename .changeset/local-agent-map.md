---
"@ai-hero/sandcastle": minor
---

Add a read-only host dashboard with `sandcastle dashboard`, persisted session
history, a live batch/issue agent map, recent activity, planner decisions and
reported usage. Instrument new parallel-planner-with-review and codex-afk
workflows, and expose `createAgentMap` for existing/custom workflows. The
dashboard binds only to loopback and needs no Docker socket or agent credentials.
