---
"@ai-hero/sandcastle": patch
---

Fix `close()` on a `sprites()` sandbox rejecting with `sprite not found` when the Sprite is already gone (deleted out-of-band, expired or reaped), which left the worktree on disk. A Sprite that no longer exists now counts as closed, so the worktree is removed as usual. Any other error from deleting the Sprite still rejects `close()`.
