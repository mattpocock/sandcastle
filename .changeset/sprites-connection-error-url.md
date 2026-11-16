---
"@ai-hero/sandcastle": patch
---

`sprites()`: when an `exec` connection fails, the error now names the failed connection and leaves out the exec URL's query string, which holds the command's env values.
