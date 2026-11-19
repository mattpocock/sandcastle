---
"@ai-hero/sandcastle": patch
---

Support OpenCode v2's `opencode session export` / `opencode session import`
commands for session capture and resume. The provider detects the CLI major
version, uses `--standalone` on v2 (required under bwrap), and keeps the v1
commands for older CLIs.
