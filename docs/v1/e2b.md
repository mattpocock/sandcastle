# E2B (v1)

> Pre-release: `@ai-hero/sandcastle/v1/sandboxes/e2b` is the v1 API, and it may still change.

`e2b()` makes [E2B](https://e2b.dev) sandboxes. Sandcastle creates each one, sets its lifetime from `timeLimitMinutes`, and kills it on `close()`. Its sandboxes are detachable: you can let go of the handle, get a signed finish report when the work ends, and reattach by id.

```ts
import { createSandbox, claudeCode } from "@ai-hero/sandcastle/v1";
import { e2b } from "@ai-hero/sandcastle/v1/sandboxes/e2b";

await using sandbox = await createSandbox({
  provider: e2b({ create: { metadata: { run: "r-1" } } }),
  env: { CLAUDE_CODE_OAUTH_TOKEN: token },
  timeLimitMinutes: 60,
});

const result = await sandbox.session({
  agent: claudeCode("claude-opus-4-8"),
  prompt: "Say hello.",
});
```

Install the `e2b` package (2.62.0 or later) beside Sandcastle. It's an optional peer dependency, loaded only when `e2b()` makes or finds a sandbox.

## Options

- **`apiKey`**: your E2B API key. Defaults to `E2B_API_KEY` in the host's environment. An empty string counts as unset. With no key at all, E2B's SDK rejects before any sandbox exists.
- **`domain`**: the E2B domain. Defaults to `E2B_DOMAIN`, else E2B's own (`e2b.app`).
- **`create`**: passed to E2B's `Sandbox.create`: `template`, `metadata`, `network`, `allowInternetAccess`, `volumeMounts` and the rest. Its type is exported as `E2BCreateOptions`. It leaves out the fields Sandcastle sets itself:
  - `timeoutMs` comes from `timeLimitMinutes`;
  - `lifecycle` is always `{ onTimeout: "kill", autoResume: false }`, because a paused sandbox's supervisor couldn't send its finish report;
  - `envs`: env goes to each command, never to the sandbox;
  - `apiKey` and `domain` are `e2b()`'s own options.

The credentials stay on the host. None of them reach the sandbox.

## Env

The `env` you pass to `createSandbox` reaches every command through E2B's own per-command env, on top of any `env` given to that `exec` or session. It's never set on the sandbox and never written into a command line. A reattached handle has only the `env` you pass to `reattachSandbox`.

## The default template

Sandboxes are made from E2B's `claude` template unless `create.template` names another. On 2026-11-17 it had:

- Node.js v22 (LTS), which the session supervisor needs;
- git 2.43;
- Claude Code (`claude`, in `/home/user/.local/bin`);
- no GitHub CLI (`gh`).

Commands run as the template's user (`user`), and `sudo: true` runs one as `root`. The working directory is `$HOME/workspace` (`/home/user/workspace`), made empty at create.

E2B's `base` template has no agent CLI, and its Node.js is v20, past its end of life, so it isn't a good fit.

To get `gh`, build a custom template on top of `claude` that installs it, and name it in `create.template`. Or install it with a setup `exec` after create:

```ts
await sandbox.exec({
  command: "apt-get update && apt-get install -y gh",
  sudo: true,
});
```

## Time limit

`timeLimitMinutes` (default 60) becomes the sandbox's E2B timeout. When it runs out, E2B kills the sandbox and everything in it. `sandbox.killTime` is read back from E2B (`endAt`), not worked out by Sandcastle.

Your E2B plan caps a sandbox's life: 1 hour on Hobby and 24 hours on Pro. A longer `timeLimitMinutes` fails at create with E2B's own message, such as `400: Timeout cannot be greater than 1 hours`. The default of 60 minutes is already the Hobby cap.

Commands have no time limit of their own: Sandcastle runs every one with E2B's `timeoutMs: 0`, since E2B would otherwise end a command after 60 seconds.

## Detach

The session supervisor runs as an E2B background command, which the host disconnects from without killing it. It keeps running after you call `detach()` and let go of the handle, until its work ends, its deadline passes, or the sandbox's kill time.

- The finish report goes from inside the sandbox, so its URL must be reachable from the internet (or from wherever your network rules allow). If the receiver is itself in an E2B sandbox, create that one with `network: { allowPublicTraffic: true }`: E2B otherwise answers 403 to any request without its traffic token.
- `reattachSandbox({ provider: e2b(), sandboxId })` connects to the sandbox by id and ignores `create`. Connecting asks E2B for exactly the time that's left, so a reattach never moves the kill time. (A connect without a timeout gives a running sandbox at least 5 more minutes.)
- A sandbox that has been killed, or whose time has run out, makes `reattachSandbox` reject with `SandboxUnavailableError`.
- E2B keeps no output of a command after it exits. That's fine: the supervisor writes its own log and status files, which `status()` reads.
- If the host loses its stream to a command it's waiting on, that `exec` or session rejects saying so, rather than hanging. E2B can't replay what was missed.

## Network

Outbound internet is on by default. Restrict it through `create`:

```ts
import { ALL_TRAFFIC } from "e2b";

e2b({
  create: {
    network: {
      denyOut: [ALL_TRAFFIC],
      allowOut: ["api.anthropic.com", "github.com", "api.github.com"],
    },
  },
});
```

`allowInternetAccess: false` turns all of it off. A restricted sandbox must still reach the agent's API, your git host, and your finish-report URL if you detach.

## What's left behind

- `close()` kills the sandbox, and a second `close()` does nothing. A `close()` after `detach()` does nothing: the sandbox carries on.
- A `createSandbox` that fails after E2B made the sandbox kills it before rejecting.
- A detached sandbox you never reattach to runs until its kill time, then E2B kills it. It's never paused, so nothing is kept after that.

To find sandboxes still running, tag them with `create.metadata` and list them with E2B's CLI (`e2b sandbox list`) or SDK (`Sandbox.list()`). Kill one with `e2b sandbox kill <id>` or `Sandbox.kill(id)`.
