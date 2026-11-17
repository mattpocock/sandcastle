# Vercel sandboxes (v1)

> Pre-release: `@ai-hero/sandcastle/v1/sandboxes/vercel` is the v1 API, and it may still change.

`vercel()` makes [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) microVMs for `createSandbox`. It needs `@vercel/sandbox` 3.8.0 or later (3.x) installed beside Sandcastle.

```ts
import { createSandbox } from "@ai-hero/sandcastle/v1";
import { vercel } from "@ai-hero/sandcastle/v1/sandboxes/vercel";

await using sandbox = await createSandbox({
  provider: vercel({ create: { resources: { vcpus: 4 } } }),
  env: { GH_TOKEN: process.env.GH_TOKEN! },
  // Vercel's Hobby plan allows 45 minutes at most.
  timeLimitMinutes: 45,
});
await sandbox.exec("git clone https://github.com/you/repo .");
```

## Credentials

`vercel({ token, teamId, projectId })` takes a Vercel access token with the team and project the sandboxes belong to. Each defaults to its environment variable: `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. A token needs all three, and `vercel()` rejects a token without the other two before it calls Vercel.

With no token, `@vercel/sandbox` authenticates with Vercel's OIDC token (`VERCEL_OIDC_TOKEN`), which a Vercel deployment has and `vercel env pull` writes locally.

None of these reach the sandbox. The sandbox gets exactly the `env` you pass to `createSandbox`, on each command through Vercel's per-command env, never on the sandbox itself or on the command line.

## Creating options

`create` is passed to `@vercel/sandbox`'s `Sandbox.create`, typed from the SDK: an `image` or `source`, `resources`, `ports`, `region`, `networkPolicy`, `tags`, and anything else it takes. Sandcastle sets these fields itself, so `create` can't hold them:

- `timeout`, from `timeLimitMinutes`.
- `env`, which goes to each command instead.
- `persistent`, always `false` (see [What's left behind](#whats-left-behind)).
- `token`, `teamId` and `projectId`, which are `vercel()`'s own options.

`reattachSandbox` ignores `create`: it finds the sandbox by its id.

## The default image

With no `image`, Vercel starts `vercel/sandbox/universal`. On 2026-11-17 that was Ubuntu 26.04 with Node 24 (which the session supervisor needs), git 2.53, the GitHub CLI `gh` 2.104, and the Claude Code and Codex CLIs. Commands run as the `ubuntu` user, and `sudo: true` runs one as root through Vercel's own sudo.

The sandbox's working directory is `/vercel/sandbox/workspace`, which Sandcastle creates. Vercel's named runtimes (`runtime: "node24"` and the like) ship no agent CLI: install yours in a setup step, or build an image with it.

## Time limit

`timeLimitMinutes` becomes the sandbox's Vercel `timeout`, a hard wall clock: Vercel stops the sandbox then, whatever is running in it. The sandbox's `killTime` is Vercel's own `expiresAt`, read back after it's created.

Vercel caps the timeout by plan: 45 minutes on Hobby, 24 hours on Pro and Enterprise. `createSandbox`'s default time limit is 60 minutes, so on Hobby pass `timeLimitMinutes: 45` or less. Over the cap, Vercel refuses to create the sandbox, and `createSandbox` rejects with Vercel's message, which names the cap.

`sandbox.native.extendTimeout(ms)` extends a live sandbox. The handle you hold keeps the `killTime` it was created with; a handle from `reattachSandbox` reads the new one.

## Detaching

Vercel sandboxes are detachable. The session supervisor runs as a detached Vercel command, which carries on after your process lets go. Sandcastle never gives it a per-command timeout, because Vercel kills a command at its timeout, detached or not. The sandbox's own timeout still applies, so detached work has until `killTime`.

`reattachSandbox` finds the sandbox by its id, which is its Vercel name, and reads it afresh from Vercel. Once the sandbox has stopped, it's unavailable.

The finish report is sent from inside the sandbox, so its destination must be reachable from the public internet, and allowed by the sandbox's network policy.

## Network access

A sandbox can reach anything on the internet by default. Restrict it with `create.networkPolicy`:

```ts
vercel({
  create: {
    networkPolicy: {
      allow: [
        "github.com",
        "*.github.com",
        "api.anthropic.com",
        "registry.npmjs.org",
      ],
    },
  },
});
```

`"deny-all"` blocks everything. An allowlist keyed by domain can also set headers on matching requests, which keeps a credential out of the sandbox altogether: see Vercel's network policy docs. Remember the finish report's destination when you restrict egress.

## What's left behind

Vercel's sandboxes are persistent by default, which takes a snapshot of the filesystem every time one stops. Snapshots are kept, and count against the account's storage. Sandcastle always creates sandboxes with `persistent: false`, so stopping one leaves no snapshot.

`close()` stops the sandbox. Vercel still lists a stopped sandbox, with no snapshot and nothing running. To remove the record too, call `sandbox.native.delete()` after `close()`, or delete it in the Vercel dashboard. A sandbox nobody closes stops at its `killTime`. Vercel bills its memory while it's idle until then, so close a sandbox you're done with rather than waiting for its time limit.
