---
"@ai-hero/sandcastle": patch
---

`vercel()`: a streamed `exec` now delivers a last output line that has no trailing newline to `onLine` (`printf 'a\nb'` gives `["a", "b"]`, not `["a"]`).
