---
"@ai-hero/sandcastle": patch
---

Fix `r.fork()` with the `pi()` agent: it now passes `--fork <id>` instead of `--session <id>`, so the fork runs under a new session id and leaves the parent's session file untouched. Before, the fork resumed the parent in place, returned the parent's id, and appended to its JSONL.
