---
"@ai-hero/sandcastle": minor
---

A `BindMountSandboxHandle` can now report `sandboxHomedir` and `sandboxTmpdir`: the agent's home and a writable temp dir, as commands inside the sandbox see them. Session capture and resume build every path they use inside the sandbox from these (the Claude Code projects dir and its subagent transcripts, the Codex, pi, Cursor and Copilot session dirs, and the opencode export file) instead of a fixed `/home/agent` and `/tmp`. Both are optional and default to `/home/agent` and `/tmp`, so `docker()`, `podman()` and custom providers behave as before, and an explicit `sessionStorage` sandbox dir still wins.
