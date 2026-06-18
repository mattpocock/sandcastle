---
"@ai-hero/sandcastle": minor
---

Add Devin agent provider.

Exports a `devin(model, options?)` factory that runs the Devin CLI (`devin -p`) inside a sandbox container. Follows the cursor/copilot pattern: `captureSessions: false`, plain-text stdout streaming, no session storage.

The accompanying Dockerfile installs the Devin CLI binary directly from the release tarball (bypassing the interactive install script) and writes `credentials.toml` from `DEVIN_API_KEY` at runtime before each invocation.
