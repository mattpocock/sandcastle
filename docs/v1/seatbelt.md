# Seatbelt (v1)

> Pre-release: `@ai-hero/sandcastle/v1/sandboxes/seatbelt` is the v1 API, and it may still change.

`seatbelt()` makes each sandbox on your own Mac, with macOS's built-in Seatbelt sandbox (`/usr/bin/sandbox-exec`). It's a drop-in for a remote provider: the same handle, an empty working directory you clone your repo into, and detachable sandboxes, so a run can carry on after your process exits and report back when it's done.

```ts
import { createSandbox } from "@ai-hero/sandcastle/v1";
import { seatbelt } from "@ai-hero/sandcastle/v1/sandboxes/seatbelt";

await using sandbox = await createSandbox({
  provider: seatbelt(),
  env: { GH_TOKEN: token, CLAUDE_CODE_OAUTH_TOKEN: claudeToken },
  timeLimitMinutes: 60,
});
await sandbox.exec(
  'git clone "https://x-access-token:$GH_TOKEN@github.com/you/repo.git" .',
);
```

## What the host needs

- **macOS 14 or later.** `createSandbox` with `seatbelt()` fails on any other OS, saying it needs macOS. On Linux, or WSL2 on Windows, use `bwrap()`; Windows itself has no local provider of this kind, so run your orchestrator inside WSL2, or use `docker()` or a remote provider. Apple marks `sandbox-exec` as deprecated, but still ships it in every macOS, and Sandcastle runs the system one by its absolute path. It can't run inside another Seatbelt sandbox: macOS refuses to nest them, and `createSandbox` says so.
- **Nothing to install for the sandbox itself.**
- **The toolchain, on the host `PATH`:** Node LTS (the session supervisor runs on it), `git`, the GitHub CLI `gh`, and the agent CLI your sessions run (`claude`, `codex`…). Homebrew's (`/opt/homebrew`, `/usr/local`) and the Xcode command line tools work as they are. There's no image: the sandbox runs the host's own programs, read-only. `createSandbox` fails, naming what's missing, when `node`, `git` or `gh` isn't there.

## What the sandbox sees

Nothing of yours is mounted or readable: not your checkout, not your home folder, not your temp folders. It can't even tell whether a file there exists. Clone repos into the working directory over git, with a token in `env`.

What it does see, read-only and at their own paths:

- the host's system folders: `/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/opt` and `/private/etc`;
- the folders on the host `PATH` that hold `node`, `git`, `gh` or an agent CLI, and the install folders their symlinks point to. Where those are in your home (an `nvm` Node, `~/.local/bin/claude`), only those folders show, never the rest of your home or the home itself;
- any folders you add with `create.toolchainPaths`, for a tool installed outside the `PATH`.

Seatbelt can't remap paths, so the sandbox's own home and working directory are at their real paths on the host: `HOME` is `<sandbox.native.stateDirectory>/home`, and `sandbox.workingDirectory` is its `workspace`, which starts empty. Those and the sandbox's own tmp (`TMPDIR`) are the only places it can write.

Unix sockets reach only those in the sandbox's own folders (the session supervisor's), and the system's DNS resolver: not your SSH agent, a container engine, or another sandbox's keeper.

There's no root: `exec` with `sudo: true` rejects, saying so. Install tools on the host, or into the sandbox's home.

There's no PID namespace on macOS, so the sandbox's processes appear in the host's process list, though they can't signal the host's.

## Env

Env reaches each command through the command's own environment, never its command line, so no other process on the host can read it from a process list. It isn't written anywhere, so `reattachSandbox` takes it again.

## The time limit

There's no vendor to enforce it, so each sandbox has a keeper: a small Node process on the host, started at create in its own session, so it isn't a child of your process. Every command in the sandbox is the keeper's child, in a process group of its own. At the kill time (now plus `timeLimitMinutes`) the keeper kills them all and removes the sandbox, whether or not anyone holds it. Before that, the session supervisor stops detached work at the detach deadline and reports.

It kills by process group, never with `kill -1`, which on macOS would be every process you have. It walks the process tree down from each command, so a child that left its command's group (a detached spawn, as an agent's sessions are) is killed too. A process that left the tree as well, a daemon whose parent has already exited, isn't. When a command exits, the rest of its process group goes with it, as when a container's main process exits.

## Detach

Detached work, the session supervisor and its sessions, runs under the keeper, so it carries on after your process exits. It doesn't outlive the machine or your login: a reboot or a logout ends it, and `reattachSandbox` then rejects with `SandboxUnavailableError`.

`reattachSandbox({ provider: seatbelt(), sandboxId })` finds the sandbox from any process on the same machine, as the same user. It ignores `create`: the sandbox keeps the network and toolchain it was made with.

## Egress

The sandbox shares the host's network by default, so it reaches anything the host can, including a finish report receiver on `localhost`. There's no domain allowlist. `create: { network: "none" }` allows no IP traffic at all, not even to `localhost`, which a Seatbelt sandbox shares with the host. That rules out cloning, the agent's API and finish reports.

## What's left behind, and cleaning it up

Each sandbox is a folder on the host, `$XDG_STATE_HOME/sandcastle/sandboxes/<sandbox id>/` (`~/.local/state/sandcastle/sandboxes/` by default), holding its home, its tmp, a `sandbox.json` with its kill time, and the keeper's socket and log. `sandbox.native.stateDirectory` is its path. Keep `XDG_STATE_HOME` short: the keeper's socket path must fit in macOS's 104 bytes, and `createSandbox` fails, saying so, when it doesn't.

- `close()` has the keeper kill everything and remove the folder. A second `close()` does nothing. A detached handle's `close()` does nothing, so the run carries on.
- A `create` that fails removes the folder and stops the keeper.
- At the kill time, the keeper does what `close()` does.
- If the keeper itself dies (the machine restarts, or it's killed with `kill -9`), each command's process group dies with it, but its folder stays. Nothing sweeps those yet: remove a folder whose kill time has passed with `rm -rf`. Sandcastle never reuses one.
