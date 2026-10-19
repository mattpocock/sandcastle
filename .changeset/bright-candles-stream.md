---
"@ai-hero/sandcastle": patch
---

Fix terminal-mode streaming for reusable sandboxes so `sandbox.run()` displays parsed agent text, tool calls, and run status instead of silently buffering them.
