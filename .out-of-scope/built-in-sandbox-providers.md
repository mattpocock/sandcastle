# Built-in sandbox providers on request

Sandcastle ships a small, chosen set of **built-in** sandbox providers: the local engines (Docker, Podman), the no-op `noSandbox`, and a few remote, isolated providers (Vercel, Daytona). The remote set can grow, a little at a time, with providers Sandcastle picks itself. It does not grow because someone requested a provider.

## What gets a remote provider in-tree

A remote provider earns its place by being verified, not by being asked for. Before one ships, and again as its platform changes, it has to pass the repo's verify harness (`npm run verify`, see `.agents/skills/verify/SKILL.md`): a real agent on its cheapest model, in a real sandbox on that platform, inside an isolated world, with a clean ledger afterwards. The test suite mocks every sandbox, so only that run proves the seam works: streamed exec, stdin reaching the agent, file copy in and out, and teardown that leaves nothing behind.

Sandcastle picks which platforms to take on by how well they fit the `IsolatedSandboxHandle` contract (`src/SandboxProvider.ts`) and whether it can keep verifying them. A request, a vote count or a ready-made PR doesn't count towards that.

## Why requests alone are out of scope

Same reasoning as the agent providers: every built-in sandbox is a standing maintenance commitment. Each one wraps a third-party provisioning surface (a CLI, an SDK, an SSH control plane) whose lifecycle, auth, file-copy, and exec semantics have to be tracked as that platform changes, and each has to keep passing the verify harness. The space of "places you could run a container or microVM" is effectively unbounded; pulling every requested one in-tree grows the surface faster than it can be kept correct.

**A built-in provider is not required.** `SandboxProvider` is a public, exported interface — along with the `createIsolatedSandboxProvider` / `createBindMountSandboxProvider` helpers — re-exported from `src/index.ts` (see `src/SandboxProvider.ts`). Anyone who wants to run agents on another backend (Coder workspaces, exe.dev microVMs, Cloudflare, a bespoke fleet) can implement that interface in their own project and pass it as the `sandbox`. No change to Sandcastle is needed, and these integrations can version and release on their own cadence rather than being pinned to Sandcastle's.

The isolated-provider seam exists precisely so the long tail of execution backends lives outside the chosen built-in set.

## Prior requests

- #495 — "Add coder() isolated sandbox provider"
- #644 — "feat(sandboxes): add exe.dev isolated sandbox provider"
