---
"@ai-hero/sandcastle": minor
---

Add optional `memory` and `memorySwap` options to the `docker()` and `podman()` sandbox providers. They are thin pass-throughs to the `--memory` and `--memory-swap` flags on `docker run` / `podman run`, letting callers bound per-container memory (e.g. `memory: "512m"`, `memorySwap: "2g"`) so several concurrent sandboxes fit within a memory-constrained VM's budget. When omitted, no flag is added and the container stays unconstrained.
