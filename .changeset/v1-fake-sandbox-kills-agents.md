---
"@ai-hero/sandcastle": patch
---

v1: `fakeSandbox()` from `@ai-hero/sandcastle/v1/testing` now kills, at `close()` and at its kill time, the agents the session supervisor starts in process groups of their own. Before, each agent outlived its sandbox, orphaned, and a test suite left one running per session it spawned.
