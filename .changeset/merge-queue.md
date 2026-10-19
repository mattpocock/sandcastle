---
"@ai-hero/sandcastle": minor
---

Add an opt-in per-branch merge queue to the `parallel-planner-with-review`
workflow (`merge.mode: "per-branch"`; default `"batch"` is unchanged). Each
approved branch is integrated as soon as it is approved, one at a time, while
other pipelines continue; every merge keeps the clean-checkout, head,
ancestry and post-merge readiness guards. A merge that fails without touching
the checkout retains only that branch; anything else stops the queue. The
operator workflow form gains a Merge mode selector.
