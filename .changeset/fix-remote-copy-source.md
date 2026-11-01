---
"@ai-hero/sandcastle": patch
---

Fix `copyToWorktree` on isolated sandboxes (Vercel, Daytona): paths are now read from your repo instead of the fresh worktree, so gitignored files like `.env` and `node_modules` actually reach the sandbox. Before, they were silently skipped.
