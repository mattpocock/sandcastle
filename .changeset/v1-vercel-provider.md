---
"@ai-hero/sandcastle": minor
---

v1: `vercel()`, a Vercel sandbox provider at `@ai-hero/sandcastle/v1/sandboxes/vercel`. Its sandboxes are detachable, so `detach`, `reattachSandbox` and `status()` work as they do on `daytona()`. `create` is `@vercel/sandbox`'s own `Sandbox.create` params, minus the fields Sandcastle sets: `timeout` comes from `timeLimitMinutes` and the kill time is Vercel's `expiresAt`, env goes to each command, and `persistent` is always `false`, so stopping a sandbox leaves no snapshot behind. Auth reads `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`, else Vercel's OIDC token. The `@vercel/sandbox` peer dependency is now `>=3.8.0 <4.0.0`, for the 0.x `vercel()` too, which now reads the sandbox's id from its `name` only. See `docs/v1/vercel.md`.
