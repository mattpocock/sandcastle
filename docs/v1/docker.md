# Docker (v1)

> Pre-release: `@ai-hero/sandcastle/v1/sandboxes/docker` is the v1 API, and it may still change.

`docker()` makes sandboxes that are Docker containers on your own machine. It's a drop-in for the remote providers: the same handle, the same empty working directory you clone into, and the same `detach`, `reattachSandbox` and `status()`. Nothing of the host is mounted into the container.

```ts
import { createSandbox, claudeCode } from "@ai-hero/sandcastle/v1";
import { docker } from "@ai-hero/sandcastle/v1/sandboxes/docker";

await using sandbox = await createSandbox({
  provider: docker({ image: "my-agent-image" }),
  env: { CLAUDE_CODE_OAUTH_TOKEN: token, GH_TOKEN: ghToken },
  timeLimitMinutes: 60,
});

await sandbox.exec(
  'git clone "https://x-access-token:$GH_TOKEN@github.com/acme/app.git" .',
);

const result = await sandbox.session({
  agent: claudeCode("claude-opus-4-8"),
  prompt: "Say hello.",
});
```

## What the host needs

- The `docker` CLI on PATH, talking to a running engine. There's no npm package to install. If `docker` isn't on PATH, or its engine isn't running, `createSandbox` rejects saying which.
- On macOS and Windows, Docker Desktop, running Linux containers. On Windows, make sure `docker` runs from the terminal you start Sandcastle in. Commands run inside the Linux container and no host path ever crosses into it, so Windows needs nothing special. (Windows hosts are not yet verified.)
- On Linux, Docker Engine, with your user able to run `docker` (the `docker` group, or rootless Docker).

## Options

- **`image`** (required): the image to run. There's no default. It's pulled if the host doesn't have it.
- **`create`**: the `docker run` settings Sandcastle leaves to you, each mapped to its flag. Its type is exported as `DockerCreateOptions`:
  - `network`: one network or a list, as `--network` (`"none"`, or a network you made with `docker network create`);
  - `cpus`, as `--cpus`;
  - `memory`, as `--memory`, with `--memory-swap` set to the same value, so it's a hard cap;
  - `pidsLimit`, as `--pids-limit`;
  - `user`, as `--user`. Default the image's own user;
  - `labels`, as `--label`. Keys starting `sandcastle.` are Sandcastle's own;
  - `capAdd` and `capDrop`, as `--cap-add` and `--cap-drop`, with capability names written without `CAP_`.

There's no option for mounts, volumes, env or the entrypoint: nothing of the host is mounted, env goes to each command, and Sandcastle sets the entrypoint itself (see [Time limit](#time-limit)).

## The image

Bring an image with:

- `sh`;
- Node.js (an LTS version), which the session supervisor needs;
- git, to clone your repo in;
- the agent's CLI (`claude` for `claudeCode`, and so on);
- `gh`, if your tasks open pull requests.

A minimal Dockerfile for Claude Code:

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates gh \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
USER node
```

Build it with `docker build -t my-agent-image .` and pass `image: "my-agent-image"`. Or install what's missing with a setup `exec` after create, with `sudo: true` for root.

Commands run as the image's user (or `create.user`), and `sudo: true` runs one as root. The working directory is `$HOME/workspace` (for the `node` user, `/home/node/workspace`), or `/workspace` when the image runs as root. It's empty at create.

## Env

The `env` you pass to `createSandbox` reaches every command, on top of any `env` given to that `exec` or session. Each command gets it through `docker exec --env-file`, from a file only your user can read, which is removed once `docker` has read it. It's never set on the container (`docker run`) and never written into a command line. An env file holds one line per variable, so a value with a line break is refused. A reattached handle has only the `env` you pass to `reattachSandbox`.

## Time limit

`timeLimitMinutes` (default 60) sets `sandbox.killTime`. The container runs with `--rm`, and its entrypoint sleeps until the kill time and then exits, so Docker ends the container and removes it then, whatever is running inside, and whether or not anything on your machine is still running. The kill time is also kept on the container as the `sandcastle.kill-time` label, which `reattachSandbox` reads back. Pulling the image counts toward the time limit.

Restarting the Docker engine, or the machine, also ends every sandbox container.

## Detach

The session supervisor is started with `docker exec -d`, so it belongs to the container, not to your process. Your process can exit after `detach()`, and the supervisor keeps going until its work ends, its deadline passes, or the kill time, as long as the Docker engine runs.

- The finish report goes from inside the container, so the container must be able to reach its URL. With `network: "none"`, it can't.
- `reattachSandbox({ provider: docker({ image }), sandboxId })` finds the container by id with `docker inspect`, and ignores `image` and `create`. Any process on the same machine (with the same engine) can reattach.
- A container that has ended, or never existed, makes `reattachSandbox` reject with `SandboxUnavailableError`.

## Network

By default the container is on Docker's bridge network, and its outbound internet is open. Restrict it with `create.network`: `"none"` turns all of it off, and a network of your own lets you apply your own rules. A restricted sandbox must still reach the agent's API, your git host, and your finish-report URL if you detach.

## What's left behind

- `close()` is `docker rm -f`: it ends the container and removes it, and a second `close()` does nothing. A `close()` after `detach()` does nothing: the container carries on.
- A `createSandbox` that fails after Docker made the container removes it before rejecting.
- A container nobody closes (your process crashed, or you detached and never came back) ends at its kill time, and `--rm` removes it then.
- Nothing is written on your machine but the short-lived env files, and the image you pulled or built.

To find sandbox containers still running, list them by the label Sandcastle puts on each: `docker ps --filter label=sandcastle.kill-time`. Tag your own with `create.labels` to tell runs apart, and remove one with `docker rm -f <id>`.
