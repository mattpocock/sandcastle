---
"@ai-hero/sandcastle": patch
---

`docker()` and `podman()`: an `exec` whose engine CLI is stopped by SIGTERM before the command ends now reports a non-zero exit code, instead of 0.
