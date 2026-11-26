---
"@ai-hero/sandcastle": patch
---

The `@vercel/sandbox` peer dependency is now `>=3.8.0 <5.0.0`, so `vercel()` (v1 and 0.x) works with `@vercel/sandbox` 4.x as well as 3.8 and later. 4.x needs Node.js 22.19.0 or later. `create` on the v1 `vercel()` takes whatever the installed version's `Sandbox.create` takes, so 4.x's `credentials` passes through.
