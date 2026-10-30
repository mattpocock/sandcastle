---
"@ai-hero/sandcastle": minor
---

Add incremental post-merge readiness. With `incremental`,
`reassessGitHubReadiness` assesses only dependents of the merged issues, issues
mentioning a changed file, and issues labelled `readiness:reassess`; other
issues keep their record, and it falls back to a full assessment when changed
files cannot be computed. The `parallel-planner-with-review` workflow uses it
after merges and runs a full assessment every `readiness.fullEvery` (default 5)
post-merge assessments. New export: `selectIncrementalReadiness`.
