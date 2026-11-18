# Podman (v1)

> Pre-release: `@ai-hero/sandcastle/v1/sandboxes/podman` is the v1 API, and it may still change.

`podman()` makes sandboxes that are Podman containers on your own machine, rootless by default. It's a drop-in for the remote providers, and works like [`docker()`](./docker.md): the same handle, the same empty working directory you clone into, and the same `detach`, `reattachSandbox` and `status()`. Nothing of the host is mounted into the container.

```ts
import { createSandbox, claudeCode } from "@ai-hero/sandcastle/v1";
import { podman } from "@ai-hero/sandcastle/v1/sandboxes/podman";

await using sandbox = await createSandbox({
  provider: podman({ image: "localhost/my-agent-image" }),
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

- The `podman` CLI on PATH. There's no npm package to install. If `podman` isn't on PATH, or it can't reach Podman, `createSandbox` rejects saying which.
- On Linux, Podman itself, run as your user (rootless). For detached runs, turn lingering on (see [Detach](#detach)).
- On macOS and Windows, a Podman machine (`podman machine init`, then `podman machine start`), with `podman` running from the terminal you start Sandcastle in. Commands run inside the Linux container and no host path ever crosses into it, so Windows needs nothing special. (macOS and Windows hosts are not yet verified.)

Rootless or rootful is not an option: it's whichever Podman the `podman` CLI talks to. Your user's Podman is rootless. A rootful Podman machine (`podman machine set --rootful`), or a connection picked with `CONTAINER_CONNECTION`, is rootful.

## Options

- **`image`** (required): the image to run. There's no default. It's pulled if the host doesn't have it. Name it in full (`docker.io/library/node:22`, or `localhost/my-agent-image` for one you built) unless your Podman is set up to resolve short names.
- **`create`**: the `podman run` settings Sandcastle leaves to you, each mapped to its flag. Its type is exported as `PodmanCreateOptions`:
  - `network`: one network or a list, as `--network` (`"none"`, or a network you made with `podman network create`);
  - `cpus`, as `--cpus`;
  - `memory`, as `--memory`, with `--memory-swap` set to the same value, so it's a hard cap;
  - `pidsLimit`, as `--pids-limit`;
  - `user`, as `--user`. Default the image's own user;
  - `userns`, as `--userns` (`"auto"`, `"host"`, `"nomap"`, `"keep-id"`). Default Podman's own: rootless, the container's root is your user. Nothing is mounted, so there's no file ownership to map, and the default suits most images;
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

The minimal Dockerfile on the [Docker page](./docker.md#the-image) works as is: build it with `podman build -t my-agent-image .` and pass `image: "localhost/my-agent-image"`. Or install what's missing with a setup `exec` after create, with `sudo: true` for root.

Commands run as the image's user (or `create.user`), and `sudo: true` runs one as root (in a rootless container, root in its user namespace). The working directory is `$HOME/workspace` (for the `node` user, `/home/node/workspace`), or `/workspace` when the image runs as root. It's empty at create.

## Env

The `env` you pass to `createSandbox` reaches every command, on top of any `env` given to that `exec` or session. Each command gets it through `podman exec --env-file`, from a file only your user can read, which is removed once `podman` has read it. It's never set on the container (`podman run`) and never written into a command line. An env file holds one line per variable, so a value with a line break is refused. A reattached handle has only the `env` you pass to `reattachSandbox`.

## Time limit

`timeLimitMinutes` (default 60) sets `sandbox.killTime`. The container runs with `--rm`, and its entrypoint sleeps until the kill time and then exits, so Podman ends the container and removes it then, whatever is running inside, and whether or not anything on your machine is still running. Podman has no daemon: the container's own monitor process (`conmon`) keeps it going and removes it. The kill time is also kept on the container as the `sandcastle.kill-time` label, which `reattachSandbox` reads back. Pulling the image counts toward the time limit.

Rebooting the machine (or stopping the Podman machine) also ends every sandbox container.

## Detach

The session supervisor is started with `podman exec -d`, so it belongs to the container, not to your process. Your process can exit after `detach()`, and the supervisor keeps going until its work ends, its deadline passes, or the kill time.

- **Rootless containers end when your last login session does**, unless lingering is on for your user: `loginctl enable-linger $USER`. Without it, a detached run on a machine you log out of dies at logout. On macOS and Windows, the Podman machine must stay up.
- The finish report goes from inside the container, so the container must be able to reach its URL. With `network: "none"`, it can't.
- `reattachSandbox({ provider: podman({ image }), sandboxId })` finds the container by id with `podman inspect`, and ignores `image` and `create`. Any process run by the same user on the same machine (the same Podman) can reattach.
- A container that has ended, or never existed, makes `reattachSandbox` reject with `SandboxUnavailableError`.

## Network

By default a rootless container uses Podman's user-mode networking (pasta, or slirp4netns on older Podman), and its outbound internet is open. Restrict it with `create.network`: `"none"` turns all of it off, and a network of your own lets you apply your own rules. A restricted sandbox must still reach the agent's API, your git host, and your finish-report URL if you detach.

## What's left behind

- `close()` is `podman rm -f`: it ends the container and removes it, and a second `close()` does nothing. A `close()` after `detach()` does nothing: the container carries on.
- A `createSandbox` that fails after Podman made the container removes it before rejecting.
- A container nobody closes (your process crashed, or you detached and never came back) ends at its kill time, and `--rm` removes it then.
- Nothing is written on your machine but the short-lived env files, and the image you pulled or built.

To find sandbox containers still running, list them by the label Sandcastle puts on each: `podman ps --filter label=sandcastle.kill-time`. Tag your own with `create.labels` to tell runs apart, and remove one with `podman rm -f <id>`.
