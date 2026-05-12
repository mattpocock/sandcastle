# Docker UID alignment via build-arg + pre-flight diagnostic

Docker users on Linux with a non-1000 host UID hit `EACCES` on image-built files (`/home/agent`, Claude CLI binaries) because the Dockerfile hardcoded UID 1000. ADR-0005 reserved a build-time UID injection escape hatch — this ADR implements it.

## Decision

Align the image UID to the host UID at **build time** using Dockerfile `ARG` directives, matching ADR-0013's principle of build-time over runtime configuration.

### Build-time: Dockerfile templates gain `AGENT_UID` / `AGENT_GID` ARGs

All four agent Dockerfile templates (`CLAUDE_CODE_DOCKERFILE`, `PI_DOCKERFILE`, `CODEX_DOCKERFILE`, `OPENCODE_DOCKERFILE`) now declare:

```dockerfile
ARG AGENT_UID=1000
ARG AGENT_GID=1000
```

The existing `usermod -d /home/agent -m -l agent node` is replaced with:

```dockerfile
RUN groupmod -g $AGENT_GID node && usermod -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}
```

The `USER` directive is now numeric (`${AGENT_UID}:${AGENT_GID}`) instead of `USER agent`, so that `docker image inspect --format '{{.Config.User}}'` returns a parseable `UID:GID` for the pre-flight check.

### Build-time: `sandcastle docker build-image` defaults build-args to host UID/GID

`buildImage()` accepts a new `buildArgs: Record<string, string>` option. The CLI command defaults `AGENT_UID` to `process.getuid()` and `AGENT_GID` to `process.getgid()` on Linux/macOS. On Windows (where `getuid()` is unavailable), the ARGs keep their Dockerfile default of 1000.

### Runtime: Docker provider gains `containerUid` / `containerGid`

Mirrors the Podman provider's existing surface. Defaults to the host UID/GID (`process.getuid()` / `process.getgid()`, falling back to 1000). Used as the `--user` flag value and as the expected UID in the pre-flight check. Allows callers with hand-rolled images to declare the image's baked-in UID without rebuilding.

### Runtime: pre-flight `docker image inspect` diagnostic

Before `docker run`, the Docker provider calls `docker image inspect <img> --format '{{.Config.User}}'` and parses the numeric UID. If it doesn't match the effective UID (host UID or explicit `containerUid`), the provider throws a clear error naming both remedies:

1. Rebuild with `sandcastle docker build-image`
2. Pass `containerUid: <image-uid>` to `docker()` to match the image

Non-numeric users (e.g. legacy images using `USER agent`) and images with no `USER` directive skip the check.

## Considered options

- **Runtime `chown -R`** — rejected in ADR-0005 for performance, log spam, and read-only mount failures.
- **`--userns=remap`** (Docker daemon-level) — requires daemon config, not per-container. Not practical.
- **`fixuid` / entrypoint script** — still chowns at startup. Solves identity but not performance.
- **`--userns=keep-id`** (Podman-only) — not available in Docker. Already used by the Podman provider.
- **Skip the pre-flight check** — silent `EACCES` is the bug this fixes; early detection is essential.

## Consequences

- Existing images built without `AGENT_UID`/`AGENT_GID` still work — the ARG defaults to 1000, matching the previous behavior.
- Users with non-1000 UIDs must rebuild their image after upgrading. The pre-flight diagnostic catches this automatically and names the remedy.
- The numeric `USER` directive means `docker image inspect` returns a parseable UID. Images using `USER agent` (pre-upgrade) skip the pre-flight check silently — they still work if the host UID happens to be 1000.
- Supersedes ADR-0005's "reserved" note for the build-arg path. ADR-0005 remains accurate for the Podman side.
