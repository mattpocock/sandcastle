---
"@ai-hero/sandcastle": minor
---

Retry issue pipelines that fail for provider or infrastructure reasons, never
for task reasons. `runTaskWithRetries` classifies each failed attempt
(`provider`, `infrastructure`, `task`) and retries on the retained branch up to
`limits.taskRetries` (default 1). A shared circuit breaker stops starting new
pipelines after `limits.consecutiveProviderFailures` (default 3) consecutive
provider failures and reports the new `provider-unavailable` diagnostic. The
`parallel-planner-with-review` workflow uses both.
