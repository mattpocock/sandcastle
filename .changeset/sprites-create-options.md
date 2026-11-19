---
"@ai-hero/sandcastle": minor
---

Add a `create` option to the `sprites()` sandbox provider that passes the `@fly/sprites` SDK's `createSprite()` options through: `config` (`ramMB`, `cpus`, `storageGB`, `region`), `labels`, `waitForCapacity`, `runtime`, `environment` and `urlSettings`. Its type is the SDK's own `CreateSpriteOptions`. Omitted, Sprites are created as before.
