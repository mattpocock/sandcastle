---
"@ai-hero/sandcastle": patch
---

Fix a streamed `exec` on `daytona()` hanging forever when the command runs `exit N`. Daytona runs session commands in one long-lived shell, and a top-level `exit` ended that shell, so no exit code was ever recorded. The provider now runs each streamed command in a subshell, so it returns with exit code `N`. Should the session shell die some other way, the call now fails with an error within about 15 seconds instead of hanging.
