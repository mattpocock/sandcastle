---
"@ai-hero/sandcastle": patch
---

Fix `vercel()` leaking a sandbox when its setup fails inside the provider's `create()`, such as creating the worktree folder. The sandbox now stops before the error is thrown, instead of running until Vercel's timeout.
