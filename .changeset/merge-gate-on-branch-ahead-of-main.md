---
"@ai-hero/sandcastle": patch
---

Fix `parallel-planner` and `parallel-planner-with-review` templates (and the
repo's own self-driving `.sandcastle/run.ts`): the merge-phase filter
incorrectly gated on the implementer's `commits.length` from the current
iteration. A branch that had already been advanced by a previous iteration
whose merger never landed it would then disappear from the merger's input
forever — each subsequent iteration's implementer would find the fix in
place, produce zero new commits, and the orchestrator would filter the
branch out before the merger ever saw it.

Now asks git directly via `git rev-list --count main..<branch>` so any
branch ahead of `main` reaches the merge phase, regardless of which
iteration produced the commits.
