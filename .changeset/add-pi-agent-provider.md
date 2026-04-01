---
"@ai-hero/sandcastle": patch
---

Add pi coding agent as a supported agent provider

- Extended `AgentProvider` interface with `defaultModel`, `buildPrintCommand`, `buildInteractiveArgs`, and `parseStreamLine` methods
- Added `piProvider` for the [pi coding agent](https://github.com/badlogic/pi-mono)
- Added `agent` option to `RunOptions` (default: `"claude-code"`)
- Added `--agent` CLI flag to `init` and `interactive` commands
- Exported `AgentProvider` type, `getAgentProvider`, `claudeCodeProvider`, and `piProvider` from the public API
