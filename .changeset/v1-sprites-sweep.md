---
"@ai-hero/sandcastle": minor
---

v1: `sweepSprites({ token?, now?, graceMinutes?, dryRun? })` at `@ai-hero/sandcastle/v1/sandboxes/sprites` deletes the sprites Sandcastle made whose kill time has passed and nobody closed, for example after the host crashed. Sprites have no time limit of their own, so such a sprite persists until something deletes it; run the sweep on a schedule. It lists the sprites named with `SPRITE_NAME_PREFIX`, page by page, reads each kill time from the name, and deletes those past their kill time plus `graceMinutes` (default 15). It resolves with `{ closed, kept, skipped }` by name, never touches a sprite named another way or one whose name carries no kill time (an earlier Sandcastle's `sandcastle-<uuid>` is skipped), never runs a command in a sprite or wakes a paused one, and counts a sprite already gone as closed. `dryRun` deletes nothing and reports what it would close. The token defaults to `SPRITES_TOKEN`, then `SPRITE_TOKEN`, and stays on the host.
