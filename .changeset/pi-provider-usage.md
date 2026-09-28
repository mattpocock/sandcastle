---
"@ai-hero/sandcastle": patch
---

Populate `IterationResult.usage` for the pi agent provider by parsing token usage from assistant messages in the `agent_end` event. Usage is summed across the session so it reflects all turns, not just the final one.
