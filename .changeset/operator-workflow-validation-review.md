---
"@ai-hero/sandcastle": patch
---

Reject workflow label collisions with project-required holds and qualification
policy atomically when saving settings. Validate GitHub owner/repository syntax
and name lengths while accepting dot-prefixed repositories such as `.github`.
