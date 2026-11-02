---
"@ai-hero/sandcastle": patch
---

The `Sandbox` handle from `createSandbox()` and `worktree.createSandbox()` now exposes `sandboxId`, the provider's id for the sandbox, so a process that supervises sandboxes from outside (a run registry, a kill step for stuck runs) can inspect or remove it with the provider's own tools. `docker()` and `podman()` set it to the container name (`docker rm -f <sandboxId>`), `vercel()` and `daytona()` to the vendor's sandbox id. It is `undefined` for `noSandbox()`, `bwrap()` and `seatbelt()`, which have nothing outside the process to address. Custom providers can set `sandboxId` on their bind-mount or isolated handle.
