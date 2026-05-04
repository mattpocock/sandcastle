---
"@ai-hero/sandcastle": patch
---

internal: phase 1 control-core — multi-repo registry, deck loader from `.sandcastle/{agents.md,skills/,commands/}`, basic git telemetry (age / branch / lastCommit / testCount), persistent operative store at `~/.sandcastle/operatives/<id>.json` and `<repo>/.sandcastle/state/operatives.<id>.json`. Adds 7 new HTTP routes (additive, no breaking change to Phase 0 routes).
