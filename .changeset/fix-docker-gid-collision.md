---
"@ai-hero/sandcastle": patch
---

Fix Docker build failure when host GID collides with an existing Debian group (e.g., macOS `staff` / GID 20 conflicting with Debian `dialout`). The generated Dockerfile now reassigns any pre-existing group before aligning the `node` user's GID.
