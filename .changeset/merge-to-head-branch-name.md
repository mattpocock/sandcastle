---
"@ai-hero/sandcastle": patch
---

Fix merge-to-head runs naming two different temp branches. `run()` and `interactive()` now create the worktree on the same temp branch they show in the "Started on branch" banner, the log filename, the run summary and `{{SOURCE_BRANCH}}`, instead of generating a second name.
