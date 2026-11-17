# Modal (v1)

> Pre-release: `@ai-hero/sandcastle/v1/sandboxes/modal` is the v1 API, and it may still change.

`modal()` makes [Modal](https://modal.com) sandboxes for `createSandbox`. Its sandboxes are detachable, so `detach()`, `reattachSandbox` and `status()` work on them.

```ts
import { claudeCode, createSandbox } from "@ai-hero/sandcastle/v1";
import { modal } from "@ai-hero/sandcastle/v1/sandboxes/modal";

await using sandbox = await createSandbox({
  provider: modal(),
  env: { CLAUDE_CODE_OAUTH_TOKEN: token },
  timeLimitMinutes: 60,
});
const result = await sandbox.session({
  name: "hello",
  agent: claudeCode("claude-haiku-4-5"),
  prompt: "Say hello.",
});
```

Install `modal` (0.11.0 or later) beside Sandcastle. The `modal` SDK needs Node 22 or later on the host.

## Credentials

The options stay on the host. None of them reach the sandbox.

| Option        | Default                                                         |
| ------------- | --------------------------------------------------------------- |
| `tokenId`     | `MODAL_TOKEN_ID`, then `~/.modal.toml` (from `modal token new`) |
| `tokenSecret` | `MODAL_TOKEN_SECRET`, then `~/.modal.toml`                      |
| `environment` | `MODAL_ENVIRONMENT`, then the profile's default                 |
| `appName`     | `"sandcastle"`, created if it's missing                         |

An empty string counts as unset.

## The image

Modal has no default image of its own, so `modal()` builds one: `node:24-bookworm` (Node 24 LTS, git, tar) with Claude Code installed, and a non-root user, `sandcastle`, who owns the working directory, `/workspace`. Modal builds it once per workspace, and caches it.

The default image has no GitHub CLI (`gh`), which the bundled tasks need. Add it, or anything else, by building your own image on the same base:

```ts
import { ModalClient } from "modal";

const client = new ModalClient();
const image = client.images
  .fromRegistry("node:24-bookworm")
  .dockerfileCommands([
    "RUN apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*",
    "RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force",
    "RUN useradd --create-home --shell /bin/bash sandcastle && mkdir -p /workspace && chown sandcastle:sandcastle /workspace",
  ]);

const provider = modal({ image });
```

`image` also takes a registry tag, such as `"node:22-bookworm"`. Any image needs `sh` and `node` (the session supervisor runs on Node), and `git` and your agent's CLI for sessions. Cancelling a command needs `setsid` from util-linux, which Debian and Ubuntu images have.

### Who commands run as

Modal runs every command as root, whatever the image's `USER` says. Claude Code refuses to skip its permission prompts as root, so `modal()` runs each command as the `sandcastle` user, through `setpriv`, with that user's `HOME`, `USER` and `LOGNAME`. The env a command gets is otherwise exactly the env you passed. A command with `sudo: true` runs as root.

An image without a `sandcastle` user (or without `setpriv`) runs every command as root. To run Claude Code there, pass `IS_SANDBOX: "1"` in `createSandbox`'s `env` yourself.

Running as a non-root user has a cost. Modal starts every process with the "no new privileges" flag, so `sudo` inside a command can't become root: a tool or script that installs system packages (`apt-get`, `npm install -g`) fails as the `sandcastle` user. Install such things in the image, or run them with `sudo: true`.

## Time limit

`timeLimitMinutes` sets the sandbox's Modal lifetime (`timeoutMs`), rounded up to whole seconds. Modal ends the sandbox then, whether anyone holds it or not, and its lifetime can't be extended. Modal caps it at 24 hours, so a longer time limit rejects before anything is made. There is no idle timeout.

Modal can't read a sandbox's lifetime back, so `modal()` writes the kill time to `/var/lib/sandcastle/sandbox.json` in the sandbox at create, and `reattachSandbox` reads it from there. If that file is removed, a reattach rejects: the kill time is unknown, and Sandcastle never guesses one.

## Detaching

The session supervisor runs in a Modal exec the host never waits on. Modal keeps an exec running after the host stops reading it, and after the host process exits, so a detached run carries on until it finishes or the sandbox hits its kill time. `reattachSandbox` finds the sandbox by id. A sandbox that has finished (`poll()` has an exit code), or that Modal doesn't know, is unavailable.

Sandboxes on Modal's newer backend don't appear in `sandboxes.list()`, so keep the `sandboxId` (it's on the detach receipt) to reattach.

## Network

Outbound traffic is open by default. Restrict it through `create`, which takes `modal`'s own `sandboxes.create` params:

```ts
modal({
  create: { outboundDomainAllowlist: ["api.anthropic.com", "github.com"] },
});
modal({ create: { outboundCidrAllowlist: ["10.0.0.0/8"] } });
modal({ create: { blockNetwork: true } });
```

A blocked network also blocks the finish report and the agent's model calls. `create` takes everything else `sandboxes.create` does (`cpu`, `memoryMiB`, `regions`, `volumes`, …) except the fields Sandcastle sets: `timeoutMs` and `idleTimeoutMs` (from the time limit), `env` (it goes to each command), and `secrets`, which would put values in the sandbox that Sandcastle can't redact. Its `command` replaces the default `sleep infinity`, which keeps the sandbox running until its kill time: the sandbox ends when that command does.

## What's left behind

`close()` terminates the sandbox and closes its Modal client, and it's safe to call twice. A `create` that fails after Modal made the sandbox terminates it. After a `detach()`, `close()` does nothing. The sandbox keeps running, and billing, after its detached work is done, until its kill time: once you have the finish report, reattach and `close()` it.

The Modal App (`sandcastle`, or your `appName`) stays. It's free, and the JS SDK can't delete apps; stop it from the Modal dashboard or CLI (`modal app stop sandcastle`) if you want it gone. The default image stays cached in your workspace.
