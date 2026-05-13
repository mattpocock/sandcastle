---
"@ai-hero/sandcastle": patch
---

Three Windows-related fixes for the worktree + copy lifecycle:

- `CopyToWorktree`: when the first `cp` attempt fails and partially populates the destination, the fallback `cp -R` would nest the source INSIDE the partial dest (e.g. `node_modules/node_modules/...`), turning a recoverable error into a corrupted path tree. The fallback now clears the destination before retrying so it always operates on a fresh target.

- `createSandbox` / `createWorktree`: a failure in `copyToWorktree` or the `onWorktreeReady` host hook used to leak the just-created git worktree, causing the next run to fail with "branch already checked out". The worktree is now removed on failure before the error propagates.

- `WorktreeManager`: `git worktree list` emits forward-slash paths on every platform, while `path.join` emits backslashes on Windows. The collision-detection check, the managed-worktree-reuse check, and the `pruneStale` active-worktree Set lookup all compared the two raw, so on Windows: managed-worktree reuse was unreachable, mid-rebase reuse-by-path never matched, and `pruneStale` wiped active worktrees out from under running sandboxes. All three paths now normalize to a common slash form for comparison, and `create` returns the worktree path in native separators regardless of whether it was created or reused.
