---
"@ai-hero/sandcastle": patch
---

Harden the real-process crash-recovery regression gate with an IPC startup and
checkpoint handshake, separate phase deadlines and owned-child cleanup before
fixture removal. Preserve live-PID exclusion, actual SIGKILL and verified
checkpoint reuse checks without changing production recovery or agent timeouts.
