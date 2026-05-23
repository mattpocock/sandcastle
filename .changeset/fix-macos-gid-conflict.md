---
"@ai-hero/sandcastle": patch
---

Fix Docker image build failure on macOS hosts where the host GID (e.g. macOS `staff` GID 20) conflicts with a system group in the Debian base image (e.g. `dialout` GID 20). The `-o` (non-unique) flag is now passed to `groupmod` and `usermod` to allow the reassignment without error.
