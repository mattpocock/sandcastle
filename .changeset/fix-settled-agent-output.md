---
"@ai-hero/sandcastle": patch
---

Ignore agent output after an invocation settles so late stdout cannot restart idle-warning or timeout fibers after cancellation, an idle timeout, or a completion timeout.
