---
"@ai-hero/sandcastle": patch
---

Stopping a `seatbelt()` run with Ctrl-C (SIGINT) or SIGTERM now removes its private home and temp dir (`$TMPDIR/sandcastle-seatbelt-*`), as `bwrap()` already does. Before, every interrupted run left one behind, holding the agent's private home.
