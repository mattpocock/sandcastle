---
"@ai-hero/sandcastle": patch
---

Resolve GitHub issue states referenced by `Blocked by` and `Depends on`
sections before parallel planner prompts run, so closed prerequisites omitted
from the open-issue list no longer leave otherwise-ready work stuck.
