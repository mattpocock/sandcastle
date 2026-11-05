---
"@ai-hero/sandcastle": patch
---

Fix `sandcastle init` never creating the `Sandcastle` GitHub label on Windows. The `gh label create` command ended in a Unix-only `2>/dev/null`, which `cmd.exe` rejects, and the failure was silently ignored. The redirect was redundant, since the command already runs with `stdio: "ignore"`, so it is removed. Thanks @AntonioGassner!
