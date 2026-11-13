---
"@ai-hero/sandcastle": patch
---

Fix parallel-planner templates so planner and merger no longer run `npm install` against the bind-mounted host checkout (which rewrote the host's `node_modules`).
