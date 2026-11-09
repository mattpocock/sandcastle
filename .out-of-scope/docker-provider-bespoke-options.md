# Bespoke per-feature options on the docker() provider

Sandcastle does not add a dedicated `docker()` option for every Docker run feature (custom `context`, `ports` publishing, and similar one-off flags).

## Why this is out of scope

Docker exposes a very large configuration surface — contexts, port publishing, networks, GPU reservations, resource limits, ulimits, capabilities, dependent services, and more. Mirroring each one as a typed `docker()` option means the built-in provider grows without bound and its option type drifts toward "all of `docker run`, retyped in TypeScript." Each added flag is also a test and documentation commitment.

There is already an escape hatch that covers the full surface without per-feature flags: **a custom sandbox provider.** `createBindMountSandboxProvider()` and the `SandboxProvider` types are public and exported from `src/index.ts`, so a caller who needs a specific `docker run` (or `docker compose`) shape can wrap the container lifecycle themselves. Every Docker option is reachable this way today.

So the built-in `docker()` provider stays focused on the common path, and full-fidelity Docker control lives in a custom provider rather than an ever-growing option list.

## Prior requests

- #493 — "feat: Add Docker context option - support docker compatible runtimes"
- #519 — "Add ports option to docker() sandbox provider"
