---
"@ai-hero/sandcastle": patch
---

Copy `createWorktree({ copyToWorktree })` files into isolated sandboxes (Daytona, Vercel) started by `wt.run()`, `wt.interactive()` and `wt.createSandbox()`. They were copied into the host worktree only, and the git-bundle sync-in dropped them because they are usually gitignored.
