---
"@ai-hero/sandcastle": patch
---

Fix `RunResult.commits` including host commits and the merge commit when the host branch advances during a `merge-to-head` run. Commits are now collected from the sandbox branch prior to merging.
