---
"@ai-hero/sandcastle": patch
---

Fix dropped OpenCode output. The print command now passes `--format json` so OpenCode emits the structured event stream the parser consumes — previously it emitted plain text, so the parser received nothing and live output, tool calls, and the session ID were all dropped. `--dangerously-skip-permissions` is now passed in the sandbox so runs no longer hang on permission prompts. `parseStreamLine` surfaces assistant text and the final result from `text` events, tool calls from `tool_use` events (`bash`, `webfetch`, `task`, with a JSON fallback for other tools, gated on the completed status), the session ID from `step_start`, and error messages from `error` events.
