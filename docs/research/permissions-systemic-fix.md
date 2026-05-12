# Permissions: Systemic Diagnosis and Proposed Fix

Research document compiled during triage of #499. Catalogues every permission-related bug report (open + closed) in `mattpocock/sandcastle`, identifies the systemic root causes still live on `main`, and proposes a four-layer fix.

## 1. Taxonomy

Seven distinct root-cause categories. Three are still live; four are resolved (kept here for context).

### A — Host UID ≠ image UID on Docker (no UID alignment) — **LIVE**

The Docker provider passes `--user ${process.getuid()}:${process.getgid()}` but the image's `/home/agent` is owned by UID 1000 (the renamed `node` user). On macOS host UID is 501; on some Linux setups it's not 1000 either. Every write under `/home/agent` (`.gitconfig`, `.npm`, `.local/state`, `.cache`) → EACCES.

This was previously masked by `chownInContainer(/home/agent → host UID)` running on every container start. It was deliberately removed in commit `a971e1e` (2026-04-22) to fix #377 / #385 (chown walked into bind mounts and exploded on VirtioFS read-only `.git/objects`). Removal regressed Docker on macOS — Podman survived because it gained `--userns=keep-id:uid=1000,gid=1000` simultaneously; **Docker has no analogous flag and got nothing**.

Issues: **#502, #504, #537, #539** (also surfaces as Category D below).

### B — Single-file bind-mount with non-existent parent dir — **LIVE**

When a `MountConfig.sandboxPath` points at a file under a directory that doesn't exist in the image (e.g. `/home/agent/.codex/auth.json` against the Claude-Code Dockerfile, which never `mkdir`'d `.codex`), Docker auto-creates `/home/agent/.codex` as `root:root` and mounts the file there. The container process (UID `agent`) cannot traverse or write the parent dir.

Issues: **#499** (primary). Compounds A on Linux/macOS.

### C — Docker provider has no SELinux labels on bind mounts — **LIVE**

Podman applies `:z` by default (`src/sandboxes/podman.ts` `formatVolumeMount`). The Docker provider has no SELinux labeling at all. On Fedora with moby-engine (or Docker via podman-docker on Silverblue, suggested by `/var/home/user`), SELinux denies any container access to bind-mounted host files unless they carry `container_file_t`.

Issues: contributor to **#499**, latent for any Fedora/RHEL/CentOS Docker user.

### D — gitconfig lock — symptom of A

`SandboxLifecycle.ts` runs `git config --global --add safe.directory …` on container start. This is the first write under `/home/agent`, so it's where Category A surfaces as the user-visible error: `could not lock config file /home/agent/.gitconfig: Permission denied`. Not a separate root cause.

Issues: **#193** (different cause: `HOME=/` — fixed by injecting `HOME=/home/agent`), **#504**, **#539**.

### E — VirtioFS chown failure — **resolved**

macOS Docker Desktop's VirtioFS rejects `chown` on read-only-permissioned bind-mounted files (e.g. `.git/objects/*` at mode 0444). Fixed in #245 by making `chownInContainer` non-fatal, then obviated by removing chown entirely in #377 / `a971e1e`.

Issues: **#245, #377**.

### F — Recursive chown walks bind mounts — **resolved**

The old `chown -R /home/agent` recursed into `/home/agent/workspace` and any user mounts under `/home/agent`, producing slow startup and warnings. Resolved by `a971e1e` — Podman by namespace mapping, Docker by no-op (which regressed Category A).

Issues: **#377, #385, #327, #366**.

### G — Podman rootless namespace mapping — **resolved**

Initial Podman provider passed only `--user` without `--userns=keep-id`, so the host UID became container root and broke bind mounts. Fixed in #327 / #385 with `--userns=keep-id:uid=N,gid=N`.

Issues: **#327, #366, #385, #196**.

## 2. Current code state

### Mitigations in place

- `HOME=/home/agent` injected into env by both providers (fixes #193).
- Podman: `--userns=keep-id:uid=1000,gid=1000` + `--user 1000:1000` + `:z` SELinux label by default → A/C/G all handled on the Podman side.
- Podman: `containerUid` / `containerGid` options for image divergence.
- Podman: pre-flight `podman image inspect` and `podman machine list` checks.
- `git config --global --add safe.directory` at startup (#193 follow-up).

### Gaps

- **Docker has no UID alignment**: passes raw `process.getuid()`, no chown, no userns flag, no build-arg, no entrypoint script. Pure regression after `a971e1e`.
- **Docker has no SELinux labels** on volume mounts.
- **Neither provider pre-creates the parent directory** of a single-file mount inside the image with correct ownership.
- No `--build-arg AGENT_UID=$(id -u)` path in `sandcastle docker build-image` despite ADR-0005 explicitly listing it as the planned escape hatch.
- The init Dockerfile templates (`InitService.ts`) don't `mkdir -p /home/agent/.codex` (or any per-agent config dir) before `USER agent`.

## 3. Root cause of #499

Three overlapping faults, in order of likelihood:

1. **Bind-mount auto-creates `/home/agent/.codex` as `root:root`** (Category B). The user is using the Claude-Code template, so `/home/agent/.codex` does not exist in the image. Docker creates it for the read-only file mount. The `agent` user cannot traverse or write `auth.json` siblings. Codex's first action is to update `PATH` (also EACCES — see error: "could not update PATH: Permission denied").
2. **Host-UID mismatch under `/home/agent`** (Category A). Even if the parent dir existed, the user runs as host UID against image UID 1000; usually OK on Linux but breaks if not exact.
3. **SELinux denial on the bind mount** (Category C). `/var/home/user` strongly suggests Fedora Silverblue/Kinoite. Without `:Z` (private label) or `:z` (shared) on the Docker `-v` flag, SELinux blocks the container from reading the file at all.

The mount-handling path: the Docker provider builds `${hostPath}:${sandboxPath}[:ro]` strings with no SELinux suffix, no parent-dir mkdir, then passes them via `DockerLifecycle.startContainer` → `docker run -v …`. There is no pre-flight on the sandbox side of the mount.

## 4. Proposed fix — four layers

### Layer 1 — Restore Docker UID alignment via build-arg (covers A, all platforms)

Re-introduce host-UID alignment without a runtime chown by baking it into the image build:

- In `InitService.ts` Dockerfile templates, add `ARG AGENT_UID=1000` / `ARG AGENT_GID=1000` and change to `RUN usermod -d /home/agent -m -l agent -u $AGENT_UID node && groupmod -g $AGENT_GID agent`.
- `sandcastle docker build-image` (and `DockerLifecycle.buildImage`) gain a `buildArgs` option and pass `--build-arg AGENT_UID=$(process.getuid())` / `--build-arg AGENT_GID=$(process.getgid())` by default on Linux/macOS.
- The Docker provider keeps `--user ${hostUid}:${hostGid}` — now matches the image. No chown, no namespace flag, no recursion.
- Document that re-`build-image` is needed when host UID changes (rare).

This is ADR-0005's already-blessed escape hatch.

### Layer 2 — Pre-create parent dirs for single-file mounts (covers B)

**Runtime `chown` is a last-resort tool in this codebase** — see ADR-0005 (removed `chown -R /home/agent` because it was slow, spat log spam from walking bind mounts, and broke on read-only VirtioFS mounts) and ADR-0013 (codifying the rule). Every fix below is ordered to avoid runtime chown if at all possible.

Preferred order:

1. **Bake common parent dirs into the image at build time.** In `InitService.ts` Dockerfile templates, after `usermod`, add `RUN mkdir -p /home/agent/.codex /home/agent/.claude /home/agent/.gemini /home/agent/.config && chown -R agent:agent /home/agent`. This is build-time chown of a known-empty tree — it doesn't walk bind mounts, doesn't run on every container start, doesn't show up in user-visible logs. It fixes #499 and any future single-file mount whose target is under a standard agent config dir.
2. **For mounts under arbitrary paths** that aren't predeclared in the image: let the user mount the parent directory rather than the single file, and document this in the README. The mount API can validate at config time and emit a clear error: `mounting a file to a non-existent parent path is not supported on Docker; mount the parent directory instead, or rebuild your image with that parent dir pre-created`.
3. **Runtime chown of the parent dir only as a final fallback**, gated behind an opt-in flag (`mounts: [{ ..., createParentDir: true }]`). Targeted, single dir, non-recursive, opt-in. We do not enable this by default.

`docker exec` cannot run before the mount is established, so any runtime chown must happen against the in-container path _after_ mount. The bind mount of the _file_ won't shadow the chown of its _parent dir_ because Docker creates the parent eagerly anyway — we'd just be fixing its ownership.

### Layer 3 — `:z` SELinux label by default on Docker too (covers C)

Add `selinuxLabel?: "z" | "Z" | false` to `DockerOptions`, default `"z"` (shared, harmless on non-SELinux systems). Reuse the Podman `formatVolumeMount` helper — pull it up to a shared `mountUtils.ts`. The `:z` suffix is a no-op on non-SELinux Docker (Linux without SELinux silently ignores it; Docker Desktop on macOS/Windows ignores it too). Zero downside.

### Layer 4 — Pre-flight diagnostic for image vs host UID drift

Before `docker run`, run `docker image inspect <img> --format '{{.Config.User}}'` and compare to host UID. If mismatched and the image was not built with `--build-arg AGENT_UID`, throw a clear error pointing to `sandcastle docker build-image`. Mirror the Podman pre-flight already in place.

### Cross-platform matrix

| Platform                      |    L1 (build-arg UID)     | L2 (parent chown) | L3 (`:z` label) | L4 (pre-flight)  |
| ----------------------------- | :-----------------------: | :---------------: | :-------------: | :--------------: |
| Linux native (Docker)         |          fixes A          |      fixes B      |      no-op      |      warns       |
| Linux + SELinux (Fedora)      |          fixes A          |      fixes B      |   **fixes C**   |      warns       |
| macOS Docker Desktop VirtioFS | fixes A (UID becomes 501) |      fixes B      |      no-op      |      warns       |
| macOS Podman                  | already fixed via userns  |      fixes B      |  already fixed  | already in place |
| Windows / WSL2 Docker         |          fixes A          |      fixes B      |      no-op      |      warns       |

### Files to touch (~5 files + ADR + changeset)

- `src/sandboxes/docker.ts` — add `selinuxLabel` option, parent-dir chown step, pre-flight check, pass build-args from CLI.
- `src/sandboxes/podman.ts` — add same parent-dir chown step (Category B affects Podman too).
- `src/mountUtils.ts` (new) — promote `formatVolumeMount`, add `parentDirsToFixOwnership(mounts)` helper.
- `src/InitService.ts` — add `ARG AGENT_UID/AGENT_GID` and parameterize `usermod -u` / `groupmod -g` in all Dockerfile templates.
- `src/DockerLifecycle.ts` — extend `buildImage` to accept `buildArgs: Record<string,string>`.
- `src/cli.ts` — `docker build-image` CLI surfaces and defaults the build-args.
- New ADR: `docs/adr/0013-docker-uid-alignment-via-build-arg.md` (supersedes 0005's "reserved" note).
- Changeset (patch).

### Issues this closes

- **A** — #502, #504, #537, #539
- **B** — #499 (primary)
- **C** — hardens for any Fedora / SELinux user

The Podman-side fixes (#327, #366, #385) stay intact.
