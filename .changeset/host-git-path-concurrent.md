---
"@ai-hero/sandcastle": patch
---

Host-side git calls no longer resolve each `PATH` entry one after another before running. The check now resolves them concurrently. On WSL, where `PATH` carries dozens of slow `/mnt/c` entries, this saves about 100ms per git call, which adds up to seconds across a run's sync steps.
