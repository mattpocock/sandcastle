---
"@ai-hero/sandcastle": patch
---

merge-to-head no longer leaves the host in a bad state when something fails. A failed `run()` deletes its temp branch unless the agent left commits on it (then it's kept, with a message on how to merge or discard it). A failed merge back is aborted, so the host branch is unchanged and the suggested `git merge <temp>` retry works, and the error now includes what git said. A merge-to-head `createWorktree()` deletes its temp branch on `close()` once its commits are on another branch.
