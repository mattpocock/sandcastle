---
"@ai-hero/sandcastle": minor
---

Add `bwrap()`, a native sandbox provider for Linux and WSL2, at `@ai-hero/sandcastle/sandboxes/bwrap`. It runs each command in Bubblewrap, with no image and no daemon: the host's system dirs read-only, the worktree at its host path, a private home at `/home/agent` and a private `/tmp` (both removed on close), its own PID namespace (every process the command started dies with it, even when your Node process is hard-killed: SIGKILL, the OOM killer), the host network, and only the env vars Sandcastle passes in. `exec` with `sudo: true` rejects, and `interactive()` with a native provider throws `NativeInteractiveNotSupportedError`.

Constructing `bwrap()` checks once per process that Bubblewrap is usable, and throws a new `NativeSandboxUnavailableError` (exported from `@ai-hero/sandcastle`, with `message` and an optional `fixCommand`) if it isn't: on a non-Linux OS (use `seatbelt()` on macOS), when `bwrap` isn't on `PATH` (the fix is your distro's install command), or when the kernel blocks unprivileged user namespaces (Ubuntu 24.04+ AppArmor; the fix is an AppArmor profile for `bwrap`). It throws before any worktree exists and never falls back to running unsandboxed.

`bwrap()` runs your host's agent CLI with no image: every directory on the host `PATH` is readable inside the sandbox, plus the install root of each executable symlinked from one (an nvm-installed `codex`, a `claude` in `~/.local/bin`), and the child's `PATH` is the host `PATH` filtered to what it can see. A `PATH` entry equal to your home directory or an ancestor of it is never mounted. Add other paths with the `mounts` option: each appears at its own host path, so `sandboxPath` must equal `hostPath` (`bwrap()` throws otherwise), and `readonly` defaults to `false`.
