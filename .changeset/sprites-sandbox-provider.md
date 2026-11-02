---
"@ai-hero/sandcastle": minor
---

Add `sprites()`, a Fly.io Sprites isolated sandbox provider, at `@ai-hero/sandcastle/sandboxes/sprites`. It needs `@fly/sprites` (an optional peer dependency, which asks for Node 24 or later) and a token in `SPRITES_TOKEN` (or `SPRITE_TOKEN`, or the `token` option). Each sandbox is a new Sprite with the repo at `/home/sprite/workspace`; `sandboxId` is the Sprite's name. Sprites persist until deleted, so Sandcastle deletes the Sprite on `close()`, when setup fails, and from a background process when the run is interrupted or exits without closing it.
