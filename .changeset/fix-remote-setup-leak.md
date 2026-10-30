---
"@ai-hero/sandcastle": patch
---

Close isolated (remote) sandboxes such as Daytona and Vercel when setup fails after `create()`. A failed or timed-out sync-in or `copyToWorktree` copy-in no longer leaves the sandbox running.
