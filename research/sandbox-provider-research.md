# Sandbox Provider Research

Research for [#250](https://github.com/mattpocock/sandcastle/issues/250) — pluggable sandbox providers.

**Date:** 2026-04-10

Two provider types in Sandcastle's architecture (see [UBIQUITOUS_LANGUAGE.md](./UBIQUITOUS_LANGUAGE.md)):

- **Bind-mount sandbox provider** — host creates a worktree, provider mounts it in. No sync needed. Docker/Podman are examples.
- **Isolated sandbox provider** — own filesystem, syncs code via `copyIn`/`copyOut`/`extractCommits`. Git bundle/patch sync.

---

## Table of Contents

1. [Bind-Mount Providers](#bind-mount-providers)
   - [Container Management Tools](#container-management-tools)
   - [OCI Container Runtimes](#oci-container-runtimes-low-level)
   - [Lightweight VM-Based Sandboxes](#lightweight-vm-based-sandboxes)
   - [Process-Level Sandboxes](#process-level-sandboxes)
   - [macOS-Specific](#macos-specific)
   - [Windows-Specific](#windows-specific)
2. [Isolated Providers](#isolated-providers-cloud--remote)
3. [Not Viable](#not-viable-for-sandcastle)
4. [Summary Matrix](#summary-matrix)
5. [Recommendations](#recommendations)

---

## Bind-Mount Providers

### Container Management Tools

These are the primary candidates — they manage container lifecycles and support bind-mounting host directories.

#### Docker (Moby)

|                       |                                                                   |
| --------------------- | ----------------------------------------------------------------- |
| **URL**               | https://github.com/moby/moby                                      |
| **Stars**             | ~71.5k                                                            |
| **License**           | Apache 2.0                                                        |
| **Mount mechanism**   | Native Linux bind mounts (`-v` / `--mount type=bind`)             |
| **Mount performance** | Native on Linux. macOS/Windows via VM + virtiofs (Docker Desktop) |
| **Root required**     | Yes (daemon), rootless mode available                             |
| **Platform**          | Linux, macOS, Windows                                             |
| **API**               | CLI, REST API, Docker SDK (Go, Python, etc.)                      |

The incumbent. Universal image ecosystem. Requires a daemon. Already supported by Sandcastle.

#### Podman

|                       |                                                              |
| --------------------- | ------------------------------------------------------------ |
| **URL**               | https://github.com/containers/podman                         |
| **Stars**             | ~31.3k                                                       |
| **License**           | Apache 2.0                                                   |
| **Mount mechanism**   | Native bind mounts, user namespace support for rootless      |
| **Mount performance** | Native speed                                                 |
| **Root required**     | No (rootless is a primary feature)                           |
| **Platform**          | Linux (primary), macOS/Windows via Podman Machine            |
| **API**               | CLI (Docker-compatible), REST API (Docker-compatible socket) |

Daemonless, rootless. Docker CLI-compatible. SELinux labeling via `:z`/`:Z`. The most natural second provider after Docker.

#### nerdctl

|                       |                                                         |
| --------------------- | ------------------------------------------------------- |
| **URL**               | https://github.com/containerd/nerdctl                   |
| **Stars**             | ~10k                                                    |
| **License**           | Apache 2.0                                              |
| **Mount mechanism**   | Docker-compatible `-v`/`--mount` syntax via containerd  |
| **Mount performance** | Native speed on Linux                                   |
| **Root required**     | No (supports rootless)                                  |
| **Platform**          | Linux (primary)                                         |
| **API**               | CLI (Docker-compatible), containerd gRPC API underneath |

Docker-compatible CLI for containerd. Interesting if users want containerd without dockerd. Supports lazy-pulling, encrypted images.

#### LXC / Incus (LXD fork)

|                       |                                                     |
| --------------------- | --------------------------------------------------- |
| **URL**               | https://github.com/lxc/incus                        |
| **Stars**             | ~5.2k                                               |
| **License**           | Apache 2.0 (Incus), LGPL 2.1+ (LXC), AGPL 3.0 (LXD) |
| **Mount mechanism**   | Native Linux bind mounts via disk device config     |
| **Mount performance** | Native speed                                        |
| **Root required**     | Typically yes                                       |
| **Platform**          | Linux only                                          |
| **API**               | CLI, full REST API over Unix socket or HTTPS        |

System containers (full OS). More like lightweight VMs than app containers. Better for persistent environments. Incus is the community fork after Canonical changed LXD's license.

#### systemd-nspawn

|                       |                                                  |
| --------------------- | ------------------------------------------------ |
| **URL**               | Part of systemd                                  |
| **Stars**             | N/A                                              |
| **License**           | LGPL 2.1+                                        |
| **Mount mechanism**   | `--bind` / `--bind-ro` flags, native bind mounts |
| **Mount performance** | Native speed                                     |
| **Root required**     | Yes (rootless not fully supported)               |
| **Platform**          | Linux only (systemd-based distros)               |
| **API**               | CLI (`systemd-nspawn`, `machinectl`), D-Bus API  |

Zero additional packages on systemd-based Linux. No image registry ecosystem — you point it at a directory tree or raw image. Interesting as a "no-dependencies" Linux option.

#### Apptainer (formerly Singularity)

|                       |                                          |
| --------------------- | ---------------------------------------- |
| **URL**               | https://github.com/apptainer/apptainer   |
| **Stars**             | N/A (mature, HPC standard)               |
| **License**           | BSD 3-Clause                             |
| **Mount mechanism**   | `--bind`/`-B` flag, native bind mounts   |
| **Mount performance** | Native speed                             |
| **Root required**     | No (designed for unprivileged HPC users) |
| **Platform**          | Linux only                               |
| **API**               | CLI, Go library                          |

HPC container runtime. First-class unprivileged bind mounting. Not a typical choice for dev tooling but solid isolation.

---

### OCI Container Runtimes (Low-Level)

These are not standalone — they need Docker, Podman, or containerd on top. But swapping the OCI runtime under a management tool changes the isolation level.

| Runtime                                                                   | Stars  | License    | Description                                                                                                              | Bind mount support                      |
| ------------------------------------------------------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| **[runc](https://github.com/opencontainers/runc)**                        | ~13.2k | Apache 2.0 | Reference OCI runtime (Go). Default in Docker/containerd.                                                                | Yes (via management layer)              |
| **[crun](https://github.com/containers/crun)**                            | ~3.9k  | GPL 2.0    | OCI runtime (C). Faster startup, lower memory than runc. Default in Podman on Fedora/RHEL.                               | Yes (via management layer)              |
| **[youki](https://github.com/youki-dev/youki)**                           | ~7k    | Apache 2.0 | OCI runtime (Rust). CNCF sandbox. Drop-in runc replacement.                                                              | Yes (via management layer)              |
| **[gVisor/runsc](https://github.com/google/gvisor)**                      | ~18.1k | Apache 2.0 | Google's application kernel. Intercepts syscalls in userspace. Stronger isolation than runc. Used by GKE Sandbox, Modal. | Yes (gofer-mediated, moderate overhead) |
| **[Kata Containers](https://github.com/kata-containers/kata-containers)** | ~7.7k  | Apache 2.0 | Each container runs in a lightweight VM (QEMU/Cloud Hypervisor/Firecracker). Hardware-level isolation.                   | Yes (virtiofs, near-native perf)        |
| **[Sysbox](https://github.com/nestybox/sysbox)**                          | ~3.6k  | Apache 2.0 | Enhanced runc for Docker-in-Docker, systemd, K8s inside containers. Acquired by Docker.                                  | Yes (via management layer)              |

**Relevance:** Users could configure `docker({ runtime: 'runsc' })` or `docker({ runtime: 'kata' })` for stronger isolation while keeping Docker as the management layer. This is a provider configuration concern, not a new provider.

---

### Lightweight VM-Based Sandboxes

These provide hardware-level isolation. Could work as bind-mount providers via virtiofs.

#### Cloud Hypervisor

|                       |                                                      |
| --------------------- | ---------------------------------------------------- |
| **URL**               | https://github.com/cloud-hypervisor/cloud-hypervisor |
| **Stars**             | ~5.5k                                                |
| **License**           | Apache 2.0 / BSD 3-Clause                            |
| **Mount mechanism**   | virtiofs (vhost-user-fs with virtiofsd)              |
| **Mount performance** | Near-native                                          |
| **Root required**     | Yes (/dev/kvm)                                       |
| **Platform**          | Linux only                                           |
| **API**               | CLI, REST API over Unix socket                       |

Modern Rust-based VMM. More features than Firecracker (hotplug, VFIO). Used by Kata Containers.

#### QEMU microVMs

|                       |                                     |
| --------------------- | ----------------------------------- |
| **URL**               | https://github.com/QEMU/qemu        |
| **Stars**             | ~13k                                |
| **License**           | GPL 2.0                             |
| **Mount mechanism**   | virtiofs or 9p                      |
| **Mount performance** | virtiofs: near-native. 9p: moderate |
| **Root required**     | /dev/kvm access                     |
| **Platform**          | Linux (primary), macOS, Windows     |
| **API**               | CLI, QMP (JSON over socket)         |

The Swiss army knife. `microvm` machine type strips to near-Firecracker simplicity. Broadest architecture support.

#### Firecracker

|                       |                                                    |
| --------------------- | -------------------------------------------------- |
| **URL**               | https://github.com/firecracker-microvm/firecracker |
| **Stars**             | ~33.6k                                             |
| **License**           | Apache 2.0                                         |
| **Mount mechanism**   | **None** (block devices only, no virtiofs/9p)      |
| **Mount performance** | N/A                                                |
| **Root required**     | Yes                                                |
| **Platform**          | Linux only                                         |
| **API**               | REST API over Unix socket                          |

Powers AWS Lambda and Fargate. Fast boot (<125ms). But **no filesystem sharing** — only block devices. A Firecracker-based Sandcastle provider would have to be an **isolated provider** (git sync). A WIP virtiofs PR was never merged.

---

### Process-Level Sandboxes

Lightest weight — restrict process capabilities without containers or VMs.

#### Bubblewrap (bwrap)

|                       |                                                                 |
| --------------------- | --------------------------------------------------------------- |
| **URL**               | https://github.com/containers/bubblewrap                        |
| **Stars**             | ~6.7k                                                           |
| **License**           | LGPL 2.0+                                                       |
| **Mount mechanism**   | `--bind` (rw), `--ro-bind` (ro). Selective bind-mounts on tmpfs |
| **Mount performance** | Native speed                                                    |
| **Root required**     | No (user namespaces)                                            |
| **Platform**          | Linux only                                                      |
| **API**               | CLI only                                                        |

Used by Flatpak internally. Runs a process with restricted filesystem/network access but near-zero overhead. The host needs all tools installed (no image ecosystem). Good for a "fast local mode" where reproducibility matters less than speed.

#### Firejail

|                       |                                                   |
| --------------------- | ------------------------------------------------- |
| **URL**               | https://github.com/netblue30/firejail             |
| **Stars**             | ~7.3k                                             |
| **License**           | GPL 2.0                                           |
| **Mount mechanism**   | `--bind`, `--whitelist`, namespaces + seccomp-bpf |
| **Mount performance** | Native speed                                      |
| **Root required**     | SUID binary (security concern)                    |
| **Platform**          | Linux only                                        |
| **API**               | CLI                                               |

SUID sandbox with 1000+ app profiles. More opinionated than bubblewrap but the SUID requirement is a security concern.

#### Minijail (Google)

|                       |                                    |
| --------------------- | ---------------------------------- |
| **URL**               | https://github.com/google/minijail |
| **Stars**             | ~364                               |
| **License**           | BSD 3-Clause                       |
| **Mount mechanism**   | Mount manipulation, bind mounts    |
| **Mount performance** | Native speed                       |
| **Root required**     | Varies                             |
| **Platform**          | Linux only                         |
| **API**               | C library + CLI                    |

From ChromeOS/Android. Battle-tested but niche outside Google.

#### Landlock / landrun

|                       |                                                    |
| --------------------- | -------------------------------------------------- |
| **URL**               | https://github.com/Zouuup/landrun                  |
| **Stars**             | ~2.2k                                              |
| **License**           | MIT                                                |
| **Mount mechanism**   | Restricts access to existing paths (no new mounts) |
| **Mount performance** | Native speed                                       |
| **Root required**     | No (Linux 5.13+ kernel LSM)                        |
| **Platform**          | Linux only                                         |
| **API**               | CLI (landrun), kernel API                          |

Kernel-level access control. Not a mount mechanism — restricts which paths a process can access. Could complement bubblewrap.

---

### macOS-Specific

#### Apple Container (`container` CLI)

|                       |                                                     |
| --------------------- | --------------------------------------------------- |
| **URL**               | https://github.com/apple/container                  |
| **Stars**             | ~25.8k                                              |
| **License**           | Apache 2.0                                          |
| **Mount mechanism**   | VirtioFS via Virtualization.framework               |
| **Mount performance** | Near-native (Apple's optimized VirtioFS)            |
| **Root required**     | No                                                  |
| **Platform**          | macOS 26 (Tahoe) only, Apple Silicon only           |
| **API**               | Swift `Containerization` framework, `container` CLI |

Apple's official container runtime. Each container is a microVM. Open source. Sub-second cold start. Supports bind mounts, port publishing, and per-container networking. Requires macOS 26 on Apple silicon. In version 1.2.0, VirtioFS mount sources must be directories, `--mount` cannot encode `,` or `=` in source or target paths, and `container copy` does not traverse a live VirtioFS mount; the provider therefore validates mount paths and streams explicit file transfers through `container exec`.

#### Lima

|                       |                                                  |
| --------------------- | ------------------------------------------------ |
| **URL**               | https://github.com/lima-vm/lima                  |
| **Stars**             | ~20.7k                                           |
| **License**           | Apache 2.0 (CNCF Incubating)                     |
| **Mount mechanism**   | virtiofs (macOS 13+), 9p, reverse-sshfs          |
| **Mount performance** | virtiofs: near-native. 9p: moderate. sshfs: slow |
| **Root required**     | No                                               |
| **Platform**          | macOS (primary), Linux                           |
| **API**               | CLI (`limactl`), YAML config                     |

Powers Colima, Rancher Desktop, Finch. Wraps QEMU or Virtualization.framework. Could be used directly for tighter control than Docker Desktop.

#### Colima

|                       |                                                     |
| --------------------- | --------------------------------------------------- |
| **URL**               | https://github.com/abiosoft/colima                  |
| **Stars**             | ~28.1k                                              |
| **License**           | MIT                                                 |
| **Mount mechanism**   | virtiofs/9p/sshfs via Lima                          |
| **Mount performance** | virtiofs: 70-90% native read. 30-50% write overhead |
| **Root required**     | No                                                  |
| **Platform**          | macOS (primary), Linux                              |
| **API**               | CLI, Docker socket (Docker-compatible)              |

Popular Docker Desktop replacement. Provides a Docker socket — the Docker provider would work as-is.

#### OrbStack

|                       |                                                            |
| --------------------- | ---------------------------------------------------------- |
| **URL**               | https://orbstack.dev                                       |
| **Stars**             | ~8.4k                                                      |
| **License**           | Proprietary (free for personal use, $8/user/mo commercial) |
| **Mount mechanism**   | VirtioFS with custom dynamic caching                       |
| **Mount performance** | 75-95% native (best-in-class on macOS)                     |
| **Root required**     | No                                                         |
| **Platform**          | macOS only                                                 |
| **API**               | Docker CLI compatible, `orb` CLI                           |

Fastest Docker Desktop alternative on macOS. Provides a Docker socket — works transparently with Sandcastle's Docker provider.

#### Tart

|                       |                                                |
| --------------------- | ---------------------------------------------- |
| **URL**               | https://github.com/cirruslabs/tart             |
| **Stars**             | ~5.3k                                          |
| **License**           | Fair Source                                    |
| **Mount mechanism**   | Directory sharing via Virtualization.framework |
| **Mount performance** | Good                                           |
| **Root required**     | No                                             |
| **Platform**          | macOS only (Apple Silicon)                     |
| **API**               | CLI                                            |

macOS/Linux VMs on Apple Silicon. OCI registry integration for VM images. Primarily CI-focused.

---

### Windows-Specific

#### WSL2

|                       |                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------- |
| **Mount mechanism**   | Windows drives auto-mounted at `/mnt/c` etc. via Plan 9 (9P)                           |
| **Mount performance** | Cross-filesystem (Linux accessing /mnt/c): significantly slower. Native Linux FS: fast |
| **Root required**     | Admin for initial install                                                              |
| **Platform**          | Windows only                                                                           |
| **API**               | CLI (`wsl`), `.wslconfig`                                                              |

The standard way to run Docker/Podman on Windows. Keep project files in the Linux FS for performance.

#### Windows Sandbox

|                       |                                                         |
| --------------------- | ------------------------------------------------------- |
| **Mount mechanism**   | MappedFolders in `.wsb` XML config                      |
| **Mount performance** | Good (Hyper-V based)                                    |
| **Root required**     | Admin (Pro/Enterprise only)                             |
| **Platform**          | Windows only                                            |
| **API**               | `.wsb` files, new CLI in 24H2 but **no stdout capture** |

Disposable Windows desktop. The lack of process I/O capture makes it **unusable for Sandcastle's `exec` model**.

#### Hyper-V Containers

|                       |                                             |
| --------------------- | ------------------------------------------- |
| **Mount mechanism**   | Docker `-v`/`--mount` through Hyper-V layer |
| **Mount performance** | Moderate (VM boundary overhead)             |
| **Root required**     | Admin                                       |
| **Platform**          | Windows only                                |
| **API**               | Docker CLI (`--isolation=hyperv`)           |

Windows containers with Hyper-V isolation. Only relevant for Windows workloads, not Linux dev environments.

---

## Isolated Providers (Cloud / Remote)

None of these can bind-mount local directories. All require git bundle/patch sync.

### Purpose-Built AI Sandbox Services

These are designed specifically for running AI agents in isolated environments.

#### Daytona

|                  |                                                           |
| ---------------- | --------------------------------------------------------- |
| **URL**          | https://daytona.io                                        |
| **Stars**        | ~72.2k                                                    |
| **License**      | AGPL 3.0 (self-hostable)                                  |
| **SDKs**         | TypeScript, Python, Go, Ruby                              |
| **Startup time** | ~90ms                                                     |
| **Pricing**      | ~$0.083/hr, per-second billing, $200 free credits         |
| **Notable**      | Built-in Git support, LSP integration, unlimited sessions |

Fastest cold start. Built-in Git makes sync easier. The TS SDK and AGPL license (self-hostable) make this the strongest isolated provider candidate.

#### E2B

|                  |                                                               |
| ---------------- | ------------------------------------------------------------- |
| **URL**          | https://e2b.dev                                               |
| **Stars**        | ~11.6k                                                        |
| **License**      | Apache 2.0                                                    |
| **SDKs**         | TypeScript, Python                                            |
| **Startup time** | ~150ms                                                        |
| **Pricing**      | ~$0.083/hr, per-second. Hobby free ($100 credit). Pro $150/mo |
| **Notable**      | Firecracker microVMs, most established AI sandbox API         |

The OG AI sandbox service. Mature, well-documented, widely adopted. File operations via SDK filesystem API.

#### Runloop

|                  |                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------- |
| **URL**          | https://runloop.ai                                                                       |
| **License**      | Proprietary                                                                              |
| **SDKs**         | REST API, SDK                                                                            |
| **Startup time** | Sub-second, p95 command exec <50ms                                                       |
| **Pricing**      | $0.108/CPU/hr. Basic free ($50 credit). Pro $250/mo                                      |
| **Notable**      | Blueprints (env templates), Snapshots (state capture/restore), scales to 20K+ concurrent |

Enterprise-focused. Snapshot/restore is valuable for resuming agent sessions.

#### Modal Sandbox

|                  |                                                     |
| ---------------- | --------------------------------------------------- |
| **URL**          | https://modal.com                                   |
| **License**      | Proprietary                                         |
| **SDKs**         | Python only                                         |
| **Startup time** | Sub-second                                          |
| **Pricing**      | ~$0.14/hr (3x sandbox premium). $30/mo free credits |
| **Notable**      | gVisor isolation, GPU support, volumes              |

Strong compute platform but Python-only SDK and 3x sandbox price premium are limiting.

#### Blaxel

|                  |                                                           |
| ---------------- | --------------------------------------------------------- |
| **URL**          | https://blaxel.ai                                         |
| **License**      | Proprietary                                               |
| **SDKs**         | Python, TypeScript                                        |
| **Startup time** | 25ms resume from standby (fastest)                        |
| **Pricing**      | ~$0.083/hr, $200 free credits                             |
| **Notable**      | Auto-scale to zero after 15s idle, near-zero standby cost |

Newest entrant. Fastest resume times. Worth watching.

#### Morph Cloud

|                  |                                                                                   |
| ---------------- | --------------------------------------------------------------------------------- |
| **URL**          | https://morph.so                                                                  |
| **License**      | Proprietary                                                                       |
| **SDKs**         | Python, TypeScript                                                                |
| **Startup time** | <250ms (snapshot restore)                                                         |
| **Pricing**      | Undisclosed (free account available)                                              |
| **Notable**      | "Infinibranch" — snapshot/branch/restore. Unique for parallelized agent workloads |

Interesting primitive: branch a sandbox state and run multiple agents from the same checkpoint.

#### Northflank

|             |                                                              |
| ----------- | ------------------------------------------------------------ |
| **URL**     | https://northflank.com                                       |
| **License** | Proprietary                                                  |
| **Pricing** | $0.017/vCPU/hr (cheapest). Free sandbox tier. BYOC available |
| **Notable** | Kata + gVisor isolation, SOC 2 Type 2                        |

Cheapest per-vCPU option. BYOC means you can self-host.

#### Cloudflare Dynamic Workers

|                  |                                                     |
| ---------------- | --------------------------------------------------- |
| **URL**          | https://developers.cloudflare.com/sandbox/          |
| **License**      | Proprietary                                         |
| **Startup time** | ~ms (V8 isolates), 2-3s (container sandbox)         |
| **Pricing**      | ~$0.09/hr                                           |
| **Notable**      | V8 isolate path is JS/TS only. Container SDK is new |

V8 isolates are too restrictive for general agents. The container sandbox is worth watching.

### Dev Environment Platforms

These can create environments but aren't optimized for ephemeral AI agent sandboxes.

| Service                                                         | License     |       Local bind-mount?        | API maturity   | Startup | Notes                                                     |
| --------------------------------------------------------------- | ----------- | :----------------------------: | -------------- | ------- | --------------------------------------------------------- |
| **[Coder](https://coder.com)**                                  | AGPL 3.0    |   Yes if self-hosted locally   | High           | Varies  | Terraform-based. Added "AI Workspaces" in 2025            |
| **[DevPod](https://devpod.sh)**                                 | MPL 2.0     | Yes with local Docker provider | CLI only       | Varies  | Client-only, devcontainer-based. Interesting hybrid       |
| **[GitHub Codespaces](https://github.com/features/codespaces)** | Proprietary |               No               | High           | 30-90s  | Expensive for ephemeral use ($0.18-2.88/hr)               |
| **[Gitpod / Ona](https://gitpod.io)**                           | AGPL 3.0    |         Self-host only         | In transition  | ~30s    | Pivoted to AI agent orchestration; future unclear         |
| **[CodeSandbox](https://codesandbox.io)**                       | Proprietary |               No               | Moderate       | Unknown | SDK exists but less adopted for AI agents                 |
| **[Replit](https://replit.com)**                                | Proprietary |               No               | Low (for this) | Unknown | Building their own agent, not sandbox-as-a-service        |
| **[StackBlitz / WebContainers](https://stackblitz.com)**        | Proprietary |               No               | Moderate       | Instant | Browser-only, Node.js-only. Not viable for general agents |

### Infrastructure Primitives

Lower-level services that could host sandboxes but require more DIY.

| Service                                | License     | Startup                     | Notes                                                                           |
| -------------------------------------- | ----------- | --------------------------- | ------------------------------------------------------------------------------- |
| **[Fly Machines](https://fly.io)**     | Proprietary | Sub-second                  | REST API. Fly Volumes for persistence. $0.15/GB/mo storage. Good building block |
| **[Fly Sprites](https://sprites.dev)** | Proprietary | ~300ms (checkpoint restore) | Firecracker + persistent NVMe + checkpoint/restore. $0.07/CPU-hr                |

---

## Not Viable for Sandcastle

| Tool                                                  | Reason                                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **WebAssembly runtimes** (Wasmtime, WasmEdge, Wasmer) | WASI cannot run arbitrary Linux binaries. Agents need git, Node.js, shells, compilers. Check back in 2-3 years |
| **Flatpak**                                           | Designed for desktop app distribution. Static filesystem permissions, app-centric model                        |
| **Snap**                                              | Designed for app distribution. Strict path whitelisting, not general-purpose                                   |
| **Windows Sandbox**                                   | No stdout capture from executed processes. Cannot implement `exec` model                                       |
| **Railway / Render**                                  | Deployment platforms, not sandbox APIs. Slow startup, wrong abstraction                                        |

---

## Summary Matrix

### Bind-Mount Providers

| Tool                 | Platform | Root? | Mount perf  | Image ecosystem | API                  | License    |        Priority        |
| -------------------- | -------- | :---: | ----------- | :-------------: | -------------------- | ---------- | :--------------------: |
| **Docker**           | All      | Yes\* | Native      |       Yes       | REST, SDK            | Apache 2.0 |      Already done      |
| **Podman**           | Linux+   |  No   | Native      |    Yes (OCI)    | REST (Docker-compat) | Apache 2.0 |        **High**        |
| **nerdctl**          | Linux    |  No   | Native      |    Yes (OCI)    | CLI                  | Apache 2.0 |         Medium         |
| **Apple Containers** | macOS 26 |  No   | Near-native |    Yes (OCI)    | Swift, CLI           | Apache 2.0 |   **High** (future)    |
| **Bubblewrap**       | Linux    |  No   | Native      |       No        | CLI                  | LGPL 2.0   |         Medium         |
| **Incus**            | Linux    |  Yes  | Native      |  No (OS trees)  | REST                 | Apache 2.0 |          Low           |
| **systemd-nspawn**   | Linux    |  Yes  | Native      |  No (OS trees)  | CLI, D-Bus           | LGPL 2.1   |          Low           |
| **Kata Containers**  | Linux    |  Yes  | Near-native |    Yes (OCI)    | OCI runtime          | Apache 2.0 | Low (use under Docker) |

\* Docker rootless mode available

### Isolated Providers

| Service          | Startup     |  SDK (TS?)  |     Git support      | Pricing     | Priority  |
| ---------------- | ----------- | :---------: | :------------------: | ----------- | :-------: |
| **Daytona**      | 90ms        |     Yes     |       Built-in       | ~$0.08/hr   | **High**  |
| **E2B**          | 150ms       |     Yes     |    No (file API)     | ~$0.08/hr   | **High**  |
| **Runloop**      | <1s         |    REST     | Via repo connections | $0.11/hr    |  Medium   |
| **Blaxel**       | 25ms resume |     Yes     |       Unknown        | ~$0.08/hr   |  Medium   |
| **Morph Cloud**  | <250ms      |     Yes     |       Unknown        | Undisclosed |    Low    |
| **Modal**        | <1s         | Python only |          No          | ~$0.14/hr   |    Low    |
| **Fly Machines** | <1s         |  REST only  |          No          | Varies      | Low (DIY) |

---

## Recommendations

### Immediate (bind-mount providers)

1. **Podman** — Closest to Docker. Daemonless, rootless, Docker CLI-compatible. Many users already have it. The provider implementation would be nearly identical to Docker with different binary names and minor flag differences.

2. **Apple Container** — Native macOS bind-mount provider. Open source (Apache 2.0), sub-second startup, no Docker Desktop needed.

### Near-term (isolated providers, requires implementing git sync)

3. **Daytona** — Best isolated provider candidate. 90ms startup, TS SDK, built-in Git support (simplifies sync), AGPL (self-hostable). The Git integration means Sandcastle's bundle/patch sync could potentially be replaced by Daytona's native Git ops.

4. **E2B** — Most proven AI sandbox service. TS SDK. No built-in Git (would need full bundle/patch sync) but rock-solid API.

### Future considerations

5. **Bubblewrap** — "Fast local mode" for Linux users who don't want Docker. Near-zero overhead. No image ecosystem though — agent tools must be installed on the host. Could be valuable for CI environments where the host already has everything installed.

6. **nerdctl** — For containerd users. Docker-compatible enough that the Docker provider might work with minimal changes.

### Key architectural insight

**Bind-mounting local directories is only possible with local tools.** Every cloud service requires file syncing. This is the fundamental divide in the provider architecture:

- **Bind-mount providers** (local): Docker, Podman, nerdctl, bubblewrap, Apple Container, systemd-nspawn, Incus
- **Isolated providers** (remote): Daytona, E2B, Runloop, Blaxel, Modal, Fly Machines, Morph Cloud

The isolated provider path requires implementing the `copyIn`/`copyOut`/`extractCommits` contract — specifically the git bundle/patch sync that's defined in the type system but not yet implemented (previous implementation available in git history).
