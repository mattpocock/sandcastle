---
"@ai-hero/sandcastle": patch
---

Fix a temp-dir leak on Windows: the `sandcastle-git-*` directory holding a worktree's corrected `.git` file is now removed when the sandbox closes, or fails to start.
