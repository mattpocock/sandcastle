---
"@ai-hero/sandcastle": patch
---

Detect the host package manager (npm, pnpm, yarn, or bun) during `sandcastle init` and use it for the install commands shown in the next steps. For templates that import `zod` on the host (the planner templates), init now offers to install it with the detected package manager when it isn't already declared — preventing the `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'` crash on the first run.
