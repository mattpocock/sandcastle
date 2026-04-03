---
"@ai-hero/sandcastle": patch
---

Add package manager support to `init` command — users can now choose npm, pnpm, yarn, or bun via the `--package-manager` flag or interactive prompt. Generated Dockerfiles, scripts, and prompts are rewritten to use the selected package manager.
