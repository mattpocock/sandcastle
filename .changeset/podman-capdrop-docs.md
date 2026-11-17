---
"@ai-hero/sandcastle": patch
---

Fix the `capDrop` JSDoc example on `podman()`: Podman's default capability set already excludes `NET_RAW` and `MKNOD`, so the example now uses `CHOWN`/`SETUID` and notes this.
