---
"@ai-hero/sandcastle": patch
---

Align operator Docker builds with host UID/GID defaults while preserving saved
argument overrides, stream partial-line progress with credential redaction, and
use the saved custom Dockerfile path when starting a CLI operator run. Reject
Dockerfile symlinks escaping onto another Windows drive.
