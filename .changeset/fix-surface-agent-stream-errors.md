---
"@ai-hero/sandcastle": patch
---

Fail the run when the agent reports an error in its own stream, even if it exits 0. pi (an `agent_end` whose last message has `stopReason: "error"`) and opencode (an `error` event) both exit 0 after an API error, so `run()` used to log "Run complete" with no commit. Claude Code and Cursor `result` lines with `is_error: true`, Codex `turn.failed`, and Copilot `error` events are surfaced the same way. Custom agent providers can emit the new `error` `ParsedStreamEvent`.
