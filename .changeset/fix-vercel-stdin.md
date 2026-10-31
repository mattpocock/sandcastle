---
"@ai-hero/sandcastle": patch
---

Fix `vercel()` dropping `stdin`, so `claudeCode` (and pi, and codex resume) got the prompt `-` and the run "succeeded" with no commits. The provider now writes stdin to a file in the sandbox and redirects it into the command, as `daytona()` does.
