---
"@ai-hero/sandcastle": patch
---

Fix `daytona()` dropping `stdin`, so `claudeCode` got the prompt `-` and made no commits. The provider now writes stdin to a file in the sandbox and redirects it into the command. A failed non-streamed command on Daytona also now reports its output as `stderr`, so the error says why it failed and not just its exit code.
