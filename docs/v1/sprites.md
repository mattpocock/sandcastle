# Fly.io Sprites (v1)

> Pre-release: `@ai-hero/sandcastle/v1/sandboxes/sprites` is the v1 API, and it may still change.

`sprites()` makes each sandbox a new [Sprite](https://sprites.dev), a Fly.io microVM that persists until it's deleted. Its sandboxes are detachable: a run can carry on after your process lets go, and report back when it's done.

```ts
import { createSandbox } from "@ai-hero/sandcastle/v1";
import { sprites } from "@ai-hero/sandcastle/v1/sandboxes/sprites";

await using sandbox = await createSandbox({
  provider: sprites({ create: { labels: ["nightly"] } }),
  env: { CLAUDE_CODE_OAUTH_TOKEN: token },
  timeLimitMinutes: 60,
});
```

Install `@fly/sprites` (0.2.4 or later) beside Sandcastle. It asks for Node 24 or later on the host; it runs on Node 22 with an engines warning.

## Credentials

`sprites({ token })` takes a Sprites API token. Without one it reads `SPRITES_TOKEN`, then `SPRITE_TOKEN` (the name the Sprites CLI uses). The token stays on the host: nothing in the sandbox can read it.

`create` is passed to `@fly/sprites`' own create: `labels`, `urlSettings`, `config` and the rest. (On 2026-11-02 Sprites accepted `config`'s `cpus` and `ramMB` but gave every sprite 8 CPUs and 16 GB.) Two fields are Sandcastle's, and the types reject them: the sprite's name, which carries its kill time, and `environment`, since env goes to `createSandbox` and from there to each command.

## The default image

There's no image to choose: every sprite runs the Sprites base image, as the user `sprite` with passwordless `sudo`. It has Node 24, `git`, `curl`, the GitHub CLI `gh` and Claude Code's `claude`. Install any other agent CLI in a setup `exec`:

```ts
await sandbox.exec({ command: "npm install -g @openai/codex", sudo: true });
```

Commands start in `/home/sprite/workspace`, which starts empty.

## Env

Env never travels in a URL. Each command gets the sandbox's env, plus its own, from a file in a folder only the sprite user can read, which the command sources and deletes as it starts. (`@fly/sprites`' own exec `env` puts values in the exec WebSocket's query string, and its connection errors print that URL.) If a connection fails, Sandcastle's error drops URL queries too.

## The time limit

Sprites have no time limit of their own, and no plan caps how long one lives; plans cap how many run at once. So the kill time is now plus `timeLimitMinutes`, and the session supervisor enforces it: at the detach deadline it ends what's still running and reports. The kill time is in the sprite's name, `sandcastle-<kill time in epoch seconds>-<uuid>`, so `reattachSandbox` reads it back without waking the sprite, and `parseSpriteName` reads it for you.

Nothing deletes the sprite at the kill time. A sprite with nothing running pauses after about 30 seconds, which stops compute billing, but it still exists, and still holds its storage, until `close()` or [`sweepSprites()`](#sweeping-up-expired-sprites) deletes it.

## Detach

The session supervisor runs in an exec that carries on after your process disconnects, for as long as the sandbox has left. A sprite pauses when nothing is connected to it, so the supervisor runs inside a small keeper script that holds a Sprites Task on the sprite's own API (`/.sprite/api.sock`): it takes a 5-minute lease, renews it every minute while the supervisor runs, and releases it when the supervisor exits, once its finish report is delivered or given up. If the keeper dies, the lease runs out within 5 minutes and the sprite pauses.

The sprite can't name itself, so the finish report's receiver gets the sandbox id from the report, as on every provider. Outbound traffic is open by default, so the report reaches any public URL.

## Egress

Outbound traffic is open by default. Sprites can restrict it to a DNS allowlist through the sprite's network policy, on `native`, before you run anything:

```ts
await sandbox.native.updateNetworkPolicy({
  rules: [
    { domain: "github.com", action: "allow" },
    { domain: "*.anthropic.com", action: "allow" },
    { domain: "*", action: "deny" },
  ],
});
```

`{ include: "defaults" }` adds Sprites' own list of common development hosts (GitHub, npm, PyPI, the major AI APIs). Allow your finish report's host too. `@fly/sprites`' create takes no network policy, so `create` can't set one.

## What's left behind, and cleaning it up

- `close()` deletes the sprite; one that's already gone counts as closed, and a second `close()` does nothing. A detached handle's `close()` does nothing, so the run carries on.
- A `create` that fails deletes the sprite it made, and so does a process that exits during `create`. Once the handle exists, a process that exits leaves the sprite be, since a detached run may be working in it.
- A detached sprite is left after its finish report, so a reattached handle can reuse it. Delete it with `close()` on a reattached handle when you're done.
- A sprite whose run nobody closes (the orchestrator crashed, or never heard back) stays until something deletes it. Run `sweepSprites()` on a schedule to delete those.

## Sweeping up expired sprites

Sprites have no time limit of their own, so a sprite that nobody closes is never ended by Sprites: it persists until something deletes it. A paused sprite bills no compute, but its storage stays billed (on 2026-11-17 Fly.io's pricing page billed a sleeping sprite's cold storage at $0.02 per GB-month). `sweepSprites()` deletes the sprites Sandcastle made whose kill time has passed. It runs on the host, with your Sprites token, so call it from a job your scheduler runs, such as a GitHub Actions schedule:

```ts
// sweep.ts, run every hour by your scheduler
import { sweepSprites } from "@ai-hero/sandcastle/v1/sandboxes/sprites";

const { closed, kept, skipped } = await sweepSprites();
console.log({ closed, kept, skipped });
```

```yaml
# .github/workflows/sweep-sprites.yml
on:
  schedule:
    - cron: "17 * * * *"
jobs:
  sweep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npx tsx sweep.ts
        env:
          SPRITES_TOKEN: ${{ secrets.SPRITES_TOKEN }}
```

It lists the account's sprites whose names start with `SPRITE_NAME_PREFIX`, page by page, and reads each kill time from the name with `parseSpriteName`. It resolves with every name it listed, sorted three ways:

- **`closed`**: deleted, because its kill time plus `graceMinutes` (default 15) has passed. The grace leaves a run that reports at its deadline time to deliver its finish report. A sprite already gone counts as closed, so two sweeps at once are safe.
- **`kept`**: a Sandcastle name whose kill time, plus the grace, is still ahead.
- **`skipped`**: a name that starts with the prefix but carries no kill time it can read. An earlier Sandcastle named sprites `sandcastle-<uuid>`, with no kill time; the sweep can't tell whether one of those is still in use, so it never deletes them. Delete them yourself once you know they're finished.

It never touches a sprite named any other way, or one renamed after Sandcastle made it. It only lists and deletes, so it never runs a command in a sprite or wakes a paused one, and the sprite's reported status plays no part (it doesn't follow pauses). Deletes run one at a time; if any fails, the sweep still tries the rest, then rejects naming the ones it couldn't delete, and the next sweep tries them again.

Options:

- `token`: as for `sprites()`, it defaults to `SPRITES_TOKEN`, then `SPRITE_TOKEN`.
- `graceMinutes`: how long past its kill time a sprite is left. `0` or more.
- `dryRun: true` deletes nothing: `closed` lists what a sweep would delete.
- `now`: the time to sweep at, a `Date`. Default now.

For a policy of your own (say, a longer grace for some labels), the same sweep by hand is a list and a delete:

```ts
import { SpritesClient } from "@fly/sprites";
import {
  parseSpriteName,
  SPRITE_NAME_PREFIX,
} from "@ai-hero/sandcastle/v1/sandboxes/sprites";

const client = new SpritesClient(token);
for (const sprite of await client.listAllSprites(SPRITE_NAME_PREFIX)) {
  const killTime = parseSpriteName(sprite.name)?.killTime;
  if (killTime !== undefined && killTime.getTime() < Date.now()) {
    await client.deleteSprite(sprite.name);
  }
}
```
