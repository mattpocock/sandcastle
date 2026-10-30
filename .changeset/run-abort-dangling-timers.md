---
"@ai-hero/sandcastle": patch
---

`run()` no longer keeps the host process alive after an abort or timeout: agent output that arrives after the agent invocation has settled no longer restarts the idle-timeout and "Agent idle for N minutes" timers.
