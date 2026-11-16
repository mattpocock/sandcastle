---
"@ai-hero/sandcastle": patch
---

Report signal-terminated commands as failures in the Docker and Podman sandbox providers, so interrupted agents are no longer mistaken for successful runs. A command killed by a signal now returns `exitCode: 1` instead of `0`. Thanks @cookerpapa!
