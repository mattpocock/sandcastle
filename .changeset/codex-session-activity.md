---
"@ai-hero/sandcastle": patch
---

Avoid false Codex idle timeouts when the active rollout advances without stdout.
Supplement the existing idle timer with bounded, metadata-only activity probes
for the exact session. Preserve real silence timeouts, completion grace, abort
and cleanup behavior; never expose transcript content or infer task success from
activity. Honor sandbox session overrides and CODEX_HOME without requiring host
session mounts or enabling session capture.
