# Image commands

```bash
npm run -s verify -- sandcastle <run> docker build-image [--image-name <n>] [--dockerfile <file>]
npm run -s verify -- sandcastle <run> docker remove-image [--image-name <n>]
npm run -s verify -- sandcastle <run> podman build-image [--image-name <n>] [--containerfile <file>]
npm run -s verify -- sandcastle <run> podman remove-image [--image-name <n>]
```

## Image name

- `--image-name` wins. Otherwise the name is `sandcastle:<project dir name>`, lowercased, with anything outside `[a-z0-9_.-]` turned into `-` (`src/mountUtils.ts:39-47`).
- In a world that is `sandcastle:world-<run id>`, the name `world` prints. Cleanup removes every image whose name holds the run id, so a custom `--image-name` must hold it too, or the ledger reports it.

## Proof

- **build-image:**
  - Exit 0, then `Build complete!`.
  - `docker image inspect <name>` succeeds.
  - Docker passes `AGENT_UID`/`AGENT_GID` build args from the host (`src/cli.ts:54-61`), so `docker run --rm <name> id -u` prints the host uid.
  - Podman passes no UID args (`src/cli.ts:637-639`).
  - Without `.sandcastle/` it fails with `No .sandcastle/ found. Run \`sandcastle init\` first.`.
  - With `--dockerfile`, the build context is the cwd, not `.sandcastle/` (`src/DockerLifecycle.ts:36-68`).
- **remove-image:**
  - Exit 0, then `Image removed.`; the inspect now fails.
  - It needs no `.sandcastle/`.
- **A run against a missing image** fails before starting a container: `Image '<name>' not found locally. Build it first with 'sandcastle docker build-image'.` (`src/sandboxes/docker.ts:360-369`).

The first build of an agent's image installs its CLI over the network and takes minutes. Later worlds reuse docker's layer cache and take seconds. When the stock image can't build here, the claim is UNVERIFIABLE: there is no agent-free fallback image, because every run uses a real agent.
