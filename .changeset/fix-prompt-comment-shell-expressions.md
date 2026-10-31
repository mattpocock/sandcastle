---
"@ai-hero/sandcastle": patch
---

Shell expressions (`` !`command` ``) inside HTML comments in a prompt file no longer run. Before, the blank template's scaffolded `prompt.md` ran its own commented-out examples, so it failed as shipped (for example `gh issue list … exited with code 4`).
