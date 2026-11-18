---
"@ai-hero/sandcastle": patch
---

`run()`, `createSandbox().run()` and `createWorktree().run()`: an agent that reports an error in its own stream after it already committed now fails with the commits it made attached to `AgentError.commits`, instead of losing them.

A long streaming turn can be dropped by the provider after the agent has committed — pi then surfaces only `Connection error.` and exits 0. Sandcastle treated the stream error as authoritative and failed the iteration before it collected commits, so the work was on the branch and the worktree was preserved, but nothing in the failure pointed at it: a caller could not tell "the agent produced nothing" from "the agent finished the work and died on the way out".

Populated for every branch strategy (head, merge-to-head, named branch) and for isolated providers, whose commits are synced to the host worktree before collection. The merge is still not attempted, so a failed run leaves `HEAD` untouched.
