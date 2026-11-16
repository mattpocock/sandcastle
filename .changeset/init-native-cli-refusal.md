---
"@ai-hero/sandcastle": patch
---

`sandcastle init`: apply the native host-PATH toolchain refusal rules to the agent-CLI check, so an agent CLI found only under `/mnt`, `/run/WSL`, or the home directory / its ancestors triggers the missing-CLI warning.
