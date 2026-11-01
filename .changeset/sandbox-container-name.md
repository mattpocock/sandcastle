---
"@ai-hero/sandcastle": patch
---

The `Sandbox` handle from `createSandbox()` and `worktree.createSandbox()` now exposes `containerName` for `docker()` and `podman()` sandboxes, so a process that supervises sandboxes from outside can inspect or remove the container. It is `undefined` for providers that don't run a named container.
