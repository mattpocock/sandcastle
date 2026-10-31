---
"@ai-hero/sandcastle": minor
---

Add session resume and fork to the `opencode()` agent. OpenCode keeps sessions in its SQLite database, so after each run Sandcastle runs `opencode export <id>` in the sandbox and stores the JSON under `~/.local/share/opencode/sandcastle-sessions/<id>.json` on the host. `r.resume()` (or `resumeSession`) copies it back, runs `opencode import`, and continues with `opencode run --session <id>`; `r.fork()` adds `--fork`, so the fork gets a new session id and the parent is left alone. Opt out with `opencode(model, { captureSessions: false })`.
