---
"@ai-hero/sandcastle": patch
---

Resolve the repo's real path when a run starts, so Claude Code session capture and resume work when the repo is reached through a symlink (macOS's `/tmp` → `/private/tmp`, for instance). Thanks @bfs2021.
