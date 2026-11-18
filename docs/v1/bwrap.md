# Bubblewrap (v1)

> Pre-release: `@ai-hero/sandcastle/v1/sandboxes/bwrap` is the v1 API, and it may still change.

`bwrap()` makes each sandbox on your own Linux machine, with [Bubblewrap](https://github.com/containers/bubblewrap). It's a drop-in for a remote provider: the same handle, an empty working directory you clone your repo into, and detachable sandboxes, so a run can carry on after your process exits and report back when it's done.

```ts
import { createSandbox } from "@ai-hero/sandcastle/v1";
import { bwrap } from "@ai-hero/sandcastle/v1/sandboxes/bwrap";

await using sandbox = await createSandbox({
  provider: bwrap(),
  env: { GH_TOKEN: token, CLAUDE_CODE_OAUTH_TOKEN: claudeToken },
  timeLimitMinutes: 60,
});
await sandbox.exec(
  'git clone "https://x-access-token:$GH_TOKEN@github.com/you/repo.git" .',
);
```

## What the host needs

- **Linux, or WSL2 on Windows.** Bubblewrap needs a Linux kernel, so on Windows run your orchestrator inside WSL2, not in Windows itself: `createSandbox` with `bwrap()` fails anywhere but Linux. On macOS, use `seatbelt()`.
- **`bwrap` on the `PATH`** (the `bubblewrap` package: `sudo apt install bubblewrap`, `sudo dnf install bubblewrap`, and so on), with unprivileged user namespaces allowed. Ubuntu 24.04 and later restrict those with AppArmor. `createSandbox` checks both before it makes anything, and its error names the fix, such as an AppArmor profile for `bwrap`.
- **The toolchain, on the host `PATH`:** Node LTS (the session supervisor runs on it), `git`, the GitHub CLI `gh`, and the agent CLI your sessions run (`claude`, `codex`…). There's no image: the sandbox runs the host's own programs, read-only. `createSandbox` fails, naming what's missing, when `node`, `git` or `gh` isn't there.

## What the sandbox sees

Nothing of yours is mounted: not your checkout, not your home folder, not your `/tmp`. Clone repos into the working directory over git, with a token in `env`.

What it does see, read-only and at their own paths:

- the host's system folders: `/usr`, `/etc`, `/bin`, `/sbin`, `/lib*` and `/opt`;
- the folders on the host `PATH` that hold `node`, `git`, `gh` or an agent CLI, and the install folders their symlinks point to. Where those are in your home (an `nvm` Node, `~/.local/bin/claude`), only those folders show, never the rest of your home or the home itself;
- any folders you add with `create.toolchainPaths`, for a tool installed outside the `PATH`.

The sandbox's own home is `/home/agent`, and its working directory, `/home/agent/workspace`, starts empty. Both, and its `/tmp`, are its own, and nothing else in it is writable. Each command runs in a fresh Bubblewrap with its own PID namespace, and sees only the processes of that command.

`sudo: true` runs a command as root in the sandbox's own user namespace. That's still you on the host, so it can't write the host's folders or install system packages: install tools on the host, or into the sandbox's home.

## Env

Env reaches each command through the command's own environment, never its command line, so no other process on the host can read it from a process list. It isn't written anywhere, so `reattachSandbox` takes it again.

## The time limit

There's no vendor to enforce it, so each sandbox has a keeper: a small Node process on the host, started at create in its own session, so it isn't a child of your process. Every command in the sandbox is the keeper's child. At the kill time (now plus `timeLimitMinutes`) the keeper kills them all and removes the sandbox, whether or not anyone holds it. Before that, the session supervisor stops detached work at the detach deadline and reports.

## Detach

Detached work, the session supervisor and its sessions, runs under the keeper, so it carries on after your process exits. It doesn't outlive the machine: a reboot ends it, and `reattachSandbox` then rejects with `SandboxUnavailableError`.

`reattachSandbox({ provider: bwrap(), sandboxId })` finds the sandbox from any process on the same machine, as the same user. It ignores `create`: the sandbox keeps the network and toolchain it was made with.

## Egress

The sandbox shares the host's network by default, so it reaches anything the host can, including a finish report receiver on `localhost`. There's no domain allowlist. `create: { network: "none" }` gives it no network but its own loopback, which rules out cloning, the agent's API and finish reports.

## What's left behind, and cleaning it up

Each sandbox is a folder on the host, `$XDG_STATE_HOME/sandcastle/sandboxes/<sandbox id>/` (`~/.local/state/sandcastle/sandboxes/` by default), holding its home, its `/tmp`, a `sandbox.json` with its kill time, and the keeper's socket and log. `sandbox.native.stateDirectory` is its path.

- `close()` has the keeper kill everything and remove the folder. A second `close()` does nothing. A detached handle's `close()` does nothing, so the run carries on.
- A `create` that fails removes the folder and stops the keeper.
- At the kill time, the keeper does what `close()` does.
- If the keeper itself dies (the machine restarts, or it's killed with `kill -9`), the sandbox's commands die with it, but its folder stays. Nothing sweeps those yet: remove a folder whose kill time has passed with `rm -rf`. Sandcastle never reuses one.
