---
"@ai-hero/sandcastle": minor
---

Add `bwrap()`, a native sandbox provider for Linux and WSL2, at `@ai-hero/sandcastle/sandboxes/bwrap`. It runs each command in Bubblewrap, with no image and no daemon: the host's system dirs read-only, the worktree at its host path, a private home at `/home/agent` and a private `/tmp` (both removed on close), its own PID namespace, the host network, and only the env vars Sandcastle passes in. `exec` with `sudo: true` rejects, and `interactive()` with a native provider throws `NativeInteractiveNotSupportedError`.

`bwrap()` runs your host's agent CLI with no image: every directory on the host `PATH` is readable inside the sandbox, plus the install root of each executable symlinked from one (an nvm-installed `codex`, a `claude` in `~/.local/bin`), and the child's `PATH` is the host `PATH` filtered to what it can see. A `PATH` entry equal to your home directory or an ancestor of it is never mounted. Add other paths with the `mounts` option: each appears at its own host path, so `sandboxPath` must equal `hostPath` (`bwrap()` throws otherwise), and `readonly` defaults to `false`.
