---
"@ai-hero/sandcastle": minor
---

Add session resume to the `cursor()` agent. Sandcastle now captures each Cursor chat's `store.db` to `~/.cursor/chats/<md5-of-cwd>/<chat-id>/` on the host, byte for byte, and `r.resume()` (or `resumeSession`) copies it back into the sandbox and runs `agent --resume=<id>`. Opt out with `cursor(model, { captureSessions: false })`. The Cursor CLI has no fork, so `r.fork()` throws a `ForkNotSupportedError` naming `cursor` before any sandbox starts.
