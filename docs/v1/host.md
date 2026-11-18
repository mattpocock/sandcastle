# Host (v1)

> [!WARNING]
> **`host()` is not a sandbox.** Its commands run on your machine, as you, with no isolation. The agent can read everything you can, your home folder included (`~/.ssh`, `~/.aws`, `~/.config/gh` and every other credential on disk), write anywhere you can, and reach anything on your network. And v1 agents run with their default permission bypass here too: Claude Code gets `--dangerously-skip-permissions`, so it never stops to ask before it runs a command. Set `permissionMode` on the agent to turn that off. Use `host()` on a throwaway CI runner, or on a machine where you'd let the agent do anything you can do yourself.

> Pre-release: `@ai-hero/sandcastle/v1/sandboxes/host` is the v1 API, and it may still change.

`host()` runs each sandbox's commands on the machine your code runs on. It's for CI runners, which are already throwaway machines, and for local runs where you trust the agent. It's a drop-in for the other providers: the same handle, and an empty working directory you clone your repo into.

```ts
import { createSandbox } from "@ai-hero/sandcastle/v1";
import { host } from "@ai-hero/sandcastle/v1/sandboxes/host";

await using sandbox = await createSandbox({
  provider: host(),
  env: { GH_TOKEN: token, CLAUDE_CODE_OAUTH_TOKEN: claudeToken },
  timeLimitMinutes: 60,
});
await sandbox.exec(
  'git clone "https://x-access-token:$GH_TOKEN@github.com/you/repo.git" .',
);
```

## What the host needs

On Linux, macOS and Windows:

- **Node LTS** on the `PATH`: the session supervisor runs on it.
- **`git` and the GitHub CLI `gh`** on the `PATH`, to clone and push.
- **The agent CLI** your sessions run (`claude`, `codex`…) on the `PATH`.

There's no image and nothing to install for the provider itself. On Windows it needs no `sh`: neither Git for Windows' nor WSL's.

## It starts empty

Each sandbox is a private folder, `<rootDir>/<sandboxId>/`, holding `workspace/` (the working directory), `home/` and `tmp/`. The working directory starts empty, so clone your repo into it over git, with a token in `env`. There's no option to run in an existing folder or in `process.cwd()`: your checkout is never touched.

`rootDir` defaults to `<os.tmpdir()>/sandcastle-host`. Set it with `host({ create: { rootDir } })`. `sandbox.native.folder` is the sandbox's folder.

That folder is only where commands start. Nothing stops an agent from `cd ..` and on to anywhere you can go.

## Env

Each command gets the host's `PATH`, then the sandbox's env (from `createSandbox`), then its own (from `exec`). `HOME` and `TMPDIR` always point into the sandbox's folder, whatever you pass. On Windows so do `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP`, and each command also gets the system variables a Windows program needs to start (`SystemRoot`, `windir`, `ComSpec`, `PATHEXT` and `SystemDrive`). Nothing else of your `process.env` reaches a command.

So the agent sees a fresh home: your `~/.claude` login, `~/.gitconfig` and `gh` login are invisible to it. Pass credentials in `env` (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`), and set a git identity in the clone. Env reaches each command through its environment, never its command line.

There's no root: `exec` with `sudo: true` rejects. Commands run as you.

## How commands run

On Linux and macOS a command runs with `sh -c`, in a process group of its own, and a kill takes the whole group.

Windows has no `sh`, and `host()` doesn't use one:

- **A simple command is spawned straight from its words.** Simple means bare, `'single'`-quoted or `"double"`-quoted words, optionally after `export K=v;` statements: `node -e '…'` or `git clone https://github.com/you/repo.git .`, say. The program is found on `PATH` with `PATHEXT`, as Windows finds it.
- **A `.cmd` or `.bat`** (the `claude` that npm installs is one) runs through `cmd.exe`, with its arguments escaped for it.
- **Anything else goes to `cmd.exe` as written**, so pipes, `&&` and `$VAR` mostly fail there, and a POSIX-only command such as `mkdir -p` or `rm -rf` fails. Write a command as a `node -e` script when it has to run on every OS.
- **A kill takes the command's whole tree**, with `taskkill /T /F`.

Sandcastle's bundled tasks use POSIX commands, so they need a POSIX host (or another provider) on Windows.

## The time limit, and no detach

`host()` sandboxes are children of your process, so they can't detach: `detach()` and `reattachSandbox` with a `host()` provider are type errors, and throw if called anyway.

The kill time is now plus `timeLimitMinutes`, and your process enforces it: a timer closes the sandbox then, killing its commands and removing its folder. The timer doesn't keep your process alive. When your process exits (it ends, or gets `SIGINT`, `SIGTERM` or Ctrl+C), every sandbox it holds is closed the same way.

## What's left behind, and cleaning it up

- `close()` kills every running command, with its whole process group or tree, and removes the folder. A second `close()` does nothing.
- A `create` that fails removes the folder.
- At the kill time, and when your process exits, the same happens as on `close()`.
- If your process is killed hard (`kill -9`, or its Windows job is torn down), nothing runs: the commands it started keep running, and the folder stays. Find them by their working directory under `rootDir` and stop them, then delete the folder. Nothing sweeps stale folders for you.
