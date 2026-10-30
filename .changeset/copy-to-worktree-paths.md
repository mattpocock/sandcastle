---
"@ai-hero/sandcastle": patch
---

Fix `copyToWorktree` so each path lands at the same relative path in the worktree: a directory that already exists there (e.g. one holding tracked files) is merged into instead of nested (`cfg/cfg`), and missing parent directories of a nested path (e.g. `deep/a/b/c.txt` under an ignored `deep/`) are created instead of failing the run.
