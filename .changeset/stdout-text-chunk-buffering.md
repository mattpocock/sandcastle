---
"@ai-hero/sandcastle": patch
---

Stdout logging no longer breaks streamed agent text mid-word across lines. `ClackDisplay` now buffers text chunks into whole lines and flushes any partial line before the next tool call or status line, and at the end of the run.
