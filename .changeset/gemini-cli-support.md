---
"@ai-hero/sandcastle": patch
---

Add support for the Gemini CLI as a built-in agent provider.

This change also implements ADR 0012, moving session storage logic from the core orchestrator into individual agent providers. This allows providers like Gemini CLI to manage their own session file layouts and resume mechanisms.

- Added `gemini()` factory to `AgentProvider`.
- Refactored `AgentProvider` interface to include `sessionStorage`.
- Updated `claudeCode()` to manage its own session storage.
- Removed `SessionPaths` and `defaultSessionPathsLayer`.
- Updated `sandcastle init` to include Gemini CLI as an option.
