---
"@ai-hero/sandcastle": minor
---

Add `memory` and `pidsLimit` options to the `docker()` and `podman()` sandbox providers.

`memory` maps to `--memory` (with `--memory-swap` set to the same value — a hard cap with no swap headroom); `pidsLimit` maps to `--pids-limit`. Both complement the existing `cpus` option for resource-capping untrusted workloads (e.g. fork bombs, memory exhaustion). Omitted options add no flags, preserving current behavior.
