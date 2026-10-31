# Native sandbox providers: the host OS's own process sandbox, one provider per mechanism

## Context

Docker and Podman need a container engine (and a VM on macOS and Windows) and an image that installs the agent CLIs and toolchain a second time. The alternative, `noSandbox()`, runs the agent on the host with the whole home directory, its credentials and its environment in reach. Linux (and WSL2) ships Bubblewrap and macOS ships Seatbelt: lightweight process sandboxes that Claude Code, Codex and MXC already use (#1272).

## Decision

Sandcastle ships **native sandbox providers**: bind-mount sandbox providers built on the host OS's process sandbox.

- **One provider per mechanism.** `bwrap()` (`@ai-hero/sandcastle/sandboxes/bwrap`) for Linux and WSL2, `seatbelt()` for macOS. No `native()` picker before v1. They share no provider code with each other or with Docker and Podman; only pure, provider-agnostic helpers may be shared. Both are built with `createBindMountSandboxProvider`: no new provider tag, no change to the `SandboxProvider` union.
- **Paths at their host paths.** Every mount core passes is applied at its host path, in order, so the read-only git control-file overlays land on top of their writable parents. The handle's `worktreePath` is the host worktree path, so the worktree's `gitdir:` pointer resolves unchanged. User mounts must have `sandboxPath` equal to `hostPath`.
- **No image; the host toolchain.** The system dirs are mounted read-only, and the agent runs the host's own tools.
- **A private home.** Each sandbox gets a fresh home at `/home/agent` (its `sandboxHomedir`) and a private temp dir, both removed on close. Logins come only from env vars, so the host's stored logins stay hidden.
- **Open egress, host localhost reachable** in this version. Restricting the network is later work.
- **Never falling back to `noSandbox()`.** A native provider that can't start fails loudly with the command that fixes it. It never runs the agent unsandboxed.
- **No root.** `exec` with `sudo: true` rejects, naming the provider and pointing to `docker()`.
- **No `interactive()`.** `interactive()` is removed in v1 (#1058), so native providers refuse it with `NativeInteractiveNotSupportedError` instead of gaining an interactive mode.

## Considered Options

- **A container runtime with a rootless engine.** Rejected: it still needs an image and, off Linux, a VM.
- **One `native()` provider that picks by OS.** Deferred to v1's OS-based default: two explicit providers keep each mechanism's options and limits visible.
- **Remapping paths** (bwrap can mount anywhere). Rejected: Seatbelt can't, and one rule across OSes keeps absolute-path tooling working the same everywhere.
- **Falling back to `noSandbox()`** when the tool is missing. Rejected: a broken setup must never be a silent security downgrade.

## Consequences

- The agent's toolchain is whatever the host has; there is no image to keep in step.
- Containment is a shared-kernel process sandbox: about runc-grade on Linux, weaker than Docker Desktop's VM on macOS. Remote providers remain the option for stronger isolation.
- Each `exec` is a fresh sandboxed process; background processes don't survive from one `exec` to the next.
