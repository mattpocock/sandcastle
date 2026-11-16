---
"@ai-hero/sandcastle": patch
---

Resolve Windows 8.3 short paths before comparing managed worktrees with Git's long paths. Creating or reusing a worktree from a short-path repository no longer fails the host Git guard or treats a live worktree as orphaned. Equivalent short-path `.git` and `commondir` pointers are accepted; pointers into another repository remain refused.
