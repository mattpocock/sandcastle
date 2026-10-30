---
"@ai-hero/sandcastle": minor
---

Replace single-pass review in the `parallel-planner-with-review` workflow with a
bounded review→repair loop. The reviewer emits a structured
`<review-verdict>` (`approve`, `changes-requested` or `blocked`, with findings);
on `changes-requested` the implementer repairs the findings in the same sandbox
and the reviewer re-reviews, up to `review.maxRepairRounds` (default 2; `0`
restores single-pass review). Only an approval is merged; blocked, exhausted or
malformed reviews keep the branch. Agent Map records verdicts and findings.
New API: `runReviewLoop`, `withReviewVerdict`, `parseReviewVerdict`,
`formatReviewFindings`, `reviewVerdictSchema`.
