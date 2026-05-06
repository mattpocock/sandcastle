---
"@ai-hero/sandcastle": patch
---

Add non-interactive flags to `sandcastle init`: `--sandbox-provider`, `--backlog-manager`, `--create-label`/`--skip-label`, `--build-image`/`--skip-build-image`. When all prompts have flag overrides, `init` runs without a TTY. Closes #510.
