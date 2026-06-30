---
"@ai-hero/sandcastle": patch
---

Harden Dockerfile templates: eliminate pipe patterns that silently swallow download failures, use `--no-install-recommends`, and store APT keyrings in `/etc/apt/keyrings/`.
