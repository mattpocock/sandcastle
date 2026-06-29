---
"@ai-hero/sandcastle": patch
---

Fix `sandcastle init` crashing on Windows when creating the `Sandcastle` GitHub label. The `gh label create` invocation used a Unix-only `2>/dev/null` stderr redirection, which is not valid in PowerShell/cmd. The redirection was redundant — `execSync` already runs with `stdio: "ignore"`, which discards stderr cross-platform — so it has simply been removed with no behavior change on macOS/Linux.
