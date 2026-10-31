---
"@ai-hero/sandcastle": patch
---

Fix `IterationResult.sessionFilePath` for pi: it is now the captured session JSONL on the host, as documented, instead of the sessions directory that holds it.
