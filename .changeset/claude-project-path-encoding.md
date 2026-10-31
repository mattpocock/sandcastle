---
"@ai-hero/sandcastle": patch
---

Fix Claude Code session capture for repo paths containing `.` or other non-alphanumeric characters. `encodeProjectPath` now names the `~/.claude/projects/` directory exactly as Claude Code does: every character that isn't an ASCII letter or digit becomes `-` (including `.`, `_`, spaces and a Windows drive colon), and names over 200 characters are truncated with Claude Code's hash suffix. Previously only path separators were replaced, so a captured session for a repo like `~/repos/my.app` landed in a directory `claude --resume` never looks in, and native sandboxes failed session capture for every worktree under `.sandcastle/worktrees`.
