---
"@ai-hero/sandcastle": patch
---

Close sandboxes whose provider `create()` finishes after the container start timeout (or after the run is interrupted), so a slow Daytona, Vercel, Docker or Podman create no longer leaves a sandbox running with no handle.
