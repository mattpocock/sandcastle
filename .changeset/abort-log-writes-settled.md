---
"@ai-hero/sandcastle": patch
---

`run()` and `worktree.run()`: an aborted run no longer writes to its log file after it rejects. The agent's last buffered text is flushed, and every pending log write lands, before the run settles.
