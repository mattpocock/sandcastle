# Remove runtime chown, align UIDs via namespace mapping and build-time convention

Both sandbox providers used `chown -R /home/agent` at container startup to fix ownership mismatches between bind-mounted files (host UID) and image-built files (UID 1000). This was slow, produced log spam from walking into bind mounts, and hit permission errors on read-only mounts (VirtioFS `.git/objects`, custom read-only mounts). We removed it entirely.

**Podman** now uses `--userns=keep-id:uid=N,gid=N` (Podman 4.1+), which maps the host user to a fixed UID inside the container at the namespace level. Both bind-mounted and image-built files appear owned by the same UID with no file mutation. The `containerUid`/`containerGid` options (default 1000) must match the Containerfile's agent user UID.

**Docker** drops the chown and defaults to `docker({ user: "auto" })`: host UID/GID on Linux, container UID/GID (`1000:1000` by default) on macOS and Windows. Linux keeps the old bind-mount ownership behavior, while Docker Desktop hosts keep image-owned paths such as `/home/agent` writable even when the host UID does not match the generated image's agent UID. Callers can force `docker({ user: "host" })`, `docker({ user: "container" })`, or `docker({ user: "image" })` when their setup needs a specific mode.

## Considered options

- **Targeted non-recursive chown** (chown specific dirs, skip bind mounts) — still requires knowing which paths are mounts vs image-local, still has startup cost, still produces warnings on read-only mounts.
- **Build-time UID injection** (pass host UID as build-arg, create agent user with that UID) — eliminates chown but requires Dockerfile changes for existing users. This remains available as a future escape hatch if explicit Docker user modes are not enough.
- **fixuid / entrypoint script** (runtime `/etc/passwd` mutation + chown) — industry-standard approach (used by devcontainers, fixuid) but still chowns at startup. Solves the identity problem but not the performance/log-spam problem.
- **User namespace remapping** (Docker daemon-level `--userns-remap`) — not per-container, requires daemon config changes. Not practical.

## Consequences

- Requires Podman 4.1+ (for `--userns=keep-id:uid=N,gid=N` syntax).
- If a user's Containerfile creates the agent user at a UID other than 1000, they must pass `containerUid`/`containerGid` to `podman()` — otherwise ownership breaks silently.
- Docker now uses platform-aware defaults. Users with custom images can force a mode explicitly, or set `containerUid`/`containerGid` when their image uses a non-1000 agent user.
