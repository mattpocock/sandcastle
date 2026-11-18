---
"@ai-hero/sandcastle": minor
---

v1 (`@ai-hero/sandcastle/v1/sandboxes/docker`): `docker()`, a v1 provider factory for Docker containers, a drop-in for the remote providers. `docker({ image, create })` takes a required image (with Node.js, git and `sh`) and, under `create`, the `docker run` settings Sandcastle doesn't control (`network`, `cpus`, `memory`, `pidsLimit`, `user`, `labels`, `capAdd`, `capDrop`; typed `DockerCreateOptions`). Nothing of the host is mounted: each sandbox starts with an empty working directory you clone into. Containers run detached with `--rm` and a keep-alive entrypoint that exits at the kill time, so Docker ends them then even with nothing running on the host. Env goes to each command through an owner-only `--env-file`, never to the container or a command line. They're detachable: the session supervisor is started with `docker exec -d`, and `reattachSandbox` finds the container by id. Needs only the `docker` CLI on PATH. See `docs/v1/docker.md`.
