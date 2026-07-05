---
"@ai-hero/sandcastle": patch
---

Fix workflow stop and pause control state semantics so terminal paused/stopped state is written only after active scheduled work settles, and stop requests durably record `stopping` immediately.
