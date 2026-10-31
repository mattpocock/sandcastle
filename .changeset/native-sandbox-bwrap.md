---
"@ai-hero/sandcastle": minor
---

Add `bwrap()`, a native sandbox provider for Linux and WSL2, at `@ai-hero/sandcastle/sandboxes/bwrap`. It runs each command in Bubblewrap, with no image and no daemon: the host's system dirs read-only, the worktree at its host path, a private home at `/home/agent` and a private `/tmp` (both removed on close), its own PID namespace, the host network, and only the env vars Sandcastle passes in. `exec` with `sudo: true` rejects, and `interactive()` with a native provider throws `NativeInteractiveNotSupportedError`.
