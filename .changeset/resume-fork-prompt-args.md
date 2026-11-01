---
"@ai-hero/sandcastle": patch
---

Fix `resume()` and `fork()` rejecting with "promptArgs is only supported with promptFile" after a `promptFile` + `promptArgs` run. The follow-up prompt is inline, so it no longer inherits the original run's `promptArgs`. This covers `run()` and `sandbox.run()` (including a worktree's sandbox).
