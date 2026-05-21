---
"@ai-hero/sandcastle": patch
---

Fix session capture (and token-usage reporting) on reused sandboxes.

`createSandbox`'s reuse factory did not forward the bind-mount provider handle
into the orchestrator, so the session-capture step — which copies the agent's
session JSONL out to the host and parses token usage from it — was silently
skipped on every `sandbox.run()`. Runs on reused sandboxes therefore reported
no token usage, while the one-shot `run()` (whose factory does forward the
handle) reported it correctly.

The reuse factory now forwards the bind-mount handle, matching `run()`, so
`iterations[].sessionFilePath` and token usage are populated for reused
sandboxes too.
