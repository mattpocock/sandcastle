---
"@ai-hero/sandcastle": patch
---

Without a TTY, `sandcastle init` now checks every flag it would prompt for (including `--build-image` and `--install-template-deps`) before writing anything, and names all the missing flags in one error. Before, a missing `--build-image` failed only after `.sandcastle/` had been written, leaving a partial scaffold that blocked a rerun.
