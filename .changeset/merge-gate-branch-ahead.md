---
"@ai-hero/sandcastle": patch
---

Fix the `parallel-planner` and `parallel-planner-with-review` templates stranding finished branches. The merge phase only took branches whose implementer made commits in the current cycle, so a branch advanced in an earlier cycle but never merged dropped out for good: its implementer found the work already done, made no new commits, and the merger never saw it. The merge phase now asks git which branches are ahead of the current branch (`git rev-list --count HEAD..<branch>`). Thanks @a9a4k!
