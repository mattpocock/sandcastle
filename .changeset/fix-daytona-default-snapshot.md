---
"@ai-hero/sandcastle": patch
---

Make `daytona()` work on Daytona's default snapshot. The repo now syncs into `<workdir>/workspace`, which the `daytona` user can create, instead of replacing the home directory. The resolved env (`.sandcastle/.env` keys, `daytona({ env })`, the agent's env) now reaches the sandbox as `envVars`, with explicit `create.envVars` taking precedence. The `@daytona/sdk` peer range is widened to `>=0.164.0 <1.0.0`.
