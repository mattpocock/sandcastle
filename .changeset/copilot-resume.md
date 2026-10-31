---
"@ai-hero/sandcastle": minor
---

Add session resume to the `copilot()` agent. Sandcastle now captures each Copilot session's `events.jsonl` to `~/.copilot/session-state/<id>/` on the host, and `r.resume()` (or `resumeSession`) copies it back into the sandbox and runs `copilot --resume=<id>`. Opt out with `copilot(model, { captureSessions: false })`. The Copilot CLI has no fork, so `r.fork()` throws a `ForkNotSupportedError` naming `copilot` before any sandbox starts.
