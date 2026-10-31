---
"@ai-hero/sandcastle": patch
---

Make `vercel()` work on Vercel's default image. Setup failed on every call with no `runtime`, because the default image has no `/vercel/sandbox` folder and the provider created the worktree folder without its parents. It now creates it with `mkdir -p`. The `runtime` docs now say the default image ships the `claude` CLI, and the named runtimes (`node24`, `node22`) ship none.
