---
"@ai-hero/sandcastle": patch
---

Clean up Docker sandboxes when startup fails or times out before returning a handle. Propagate startup cancellation to bind-mount providers, cancel pending Docker commands, register shutdown cleanup before startup, and make Docker handle close idempotent.
