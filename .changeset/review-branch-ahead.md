---
"@ai-hero/sandcastle": patch
---

The `parallel-planner-with-review` template now runs the reviewer whenever an issue's branch is ahead of the current branch, not only when this cycle's implementer made commits. Before, a branch whose review failed in an earlier cycle got no new commits when its issue came round again, so it skipped review and went straight to the merger. Thanks @pawridisepetmanagement for the approach (#938)!
