---
"@ai-hero/sandcastle": patch
---

Fix concurrent branch-strategy worktrees deleting each other. When several in-process `run()` calls (e.g. the `parallel-planner` template) created worktrees on different branches at once, one run's `WorktreeManager.pruneStale()` sweep could delete a sibling worktree that was mid-`git worktree add`, producing `fatal: not a git repository: .git/worktrees/…` errors and zero collected commits. `pruneStale` and `create` are now coordinated by a process-wide read/write lock: concurrent creates still run in parallel, but the destructive prune sweep is exclusive of all in-flight creates.
