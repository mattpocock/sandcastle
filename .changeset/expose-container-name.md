---
"@ai-hero/sandcastle": patch
---

Expose the container name as an optional `containerName` on the `Sandbox` returned by `createSandbox()`. The `docker()` and `podman()` providers set it; other providers leave it undefined. Custom bind-mount providers can set `containerName` on their handle.
