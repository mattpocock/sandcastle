---
"@ai-hero/sandcastle": patch
---

Add a `dockerCompose()` sandbox provider that delegates container configuration to a user-managed `docker-compose.yml`. Sandcastle invokes `docker compose run -d` against a service (default name `agent`) and injects only the per-run worktree bind mount, workdir, and env vars; image, networks, GPU reservations, resource limits, and dependent services live in the compose file. Options: `composeFile`, `serviceName`, `projectDirectory`, `projectName`, `mounts`, `env`. Closes the long-running ask in #471.
