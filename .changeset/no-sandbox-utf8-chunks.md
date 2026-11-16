---
"@ai-hero/sandcastle": patch
---

`noSandbox()` keeps multi-byte UTF-8 characters whole when a command's stdout or stderr splits one across two chunks. Before, each chunk was decoded on its own, so CJK text or emoji could come back as replacement characters (`�`). Thanks @KennyMcSimpson!
