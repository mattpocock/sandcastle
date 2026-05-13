---
"@ai-hero/sandcastle": patch
---

Three Windows-related fixes for the worktree + copy lifecycle:

- `CopyToWorktree`: replaced the shelled-out `cp -R` + fallback dance with a Node-based recursive walk. The previous approach broke on Windows: `npm install` under Git Bash creates `node_modules/.bin/*` shims as NTFS reparse points that GNU `cp` (MSYS build) cannot recreate, so the first attempt partially populated the destination, `fs.rm` could not fully clean it, and the fallback `cp -R src dest` then POSIX-nested the source inside the partial dest (producing `node_modules/node_modules/...`). The new walk uses `lstat` / `copyFile` / `readlink` / `symlink` directly, silently skipping entries whose `lstat` throws `EACCES` / `EINVAL` (unreadable MSYS reparse points). It still uses `COPYFILE_FICLONE` so Linux reflink and APFS clonefile remain in play.

- `createSandbox` / `createWorktree`: a failure in `copyToWorktree` or the `onWorktreeReady` host hook used to leak the just-created git worktree, causing the next run to fail with "branch already checked out". The worktree is now removed on failure before the error propagates.

- `WorktreeManager`: `git worktree list` emits forward-slash paths on every platform, while `path.join` emits backslashes on Windows. The collision-detection check, the managed-worktree-reuse check, and the `pruneStale` active-worktree Set lookup all compared the two raw, so on Windows: managed-worktree reuse was unreachable, mid-rebase reuse-by-path never matched, and `pruneStale` wiped active worktrees out from under running sandboxes. All three paths now normalize to a common slash form for comparison, and `create` returns the worktree path in native separators regardless of whether it was created or reused.
