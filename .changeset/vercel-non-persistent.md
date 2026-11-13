---
"@ai-hero/sandcastle": patch
---

`vercel()` now creates non-persistent sandboxes, so stopping one no longer leaves a snapshot behind that counts against your Vercel snapshot storage. Pass `persistent: true` to keep Vercel's default.
