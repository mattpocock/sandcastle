---
"@ai-hero/sandcastle": patch
---

`bwrap()` now removes each sandbox's private home and `/tmp` when a run is interrupted. Before, SIGINT or SIGTERM (a Ctrl-C) killed the sandbox's processes but left a `sandcastle-bwrap-*` dir in the host's temp dir, holding the agent's home (`.claude/`, `.claude.json`, `.gitconfig`), one more after every interrupt. The same removal runs when the process exits without closing the sandbox.
