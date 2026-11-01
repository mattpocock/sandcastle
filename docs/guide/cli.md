# CLI commands

## `sandcastle init`

Scaffolds the `.sandcastle/` config directory and, for an image-based provider, builds the container image. This is the first command you run in a new repo.

See [Init](./init.md) for what init asks, checks and writes.

| Option                    | Required | Default                      | Description                                                                                                            |
| ------------------------- | -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--image-name`            | No       | `sandcastle:<repo-dir-name>` | Image name to build, also passed as `imageName` to the scaffolded main file's sandbox                                  |
| `--agent`                 | No       | Interactive prompt           | Agent to use (`claude-code`, `pi`, `codex`, `cursor`, `opencode`, `copilot`)                                           |
| `--model`                 | No       | Agent's default model        | Model to use (e.g. `claude-sonnet-4-6`). Defaults to agent's default                                                   |
| `--sandbox`               | No       | Interactive prompt           | Sandbox provider to use (`bwrap`, `seatbelt`, `docker`, `podman`)                                                      |
| `--template`              | No       | Interactive prompt           | Template to scaffold (e.g. `blank`, `simple-loop`)                                                                     |
| `--issue-tracker`         | No       | Interactive prompt           | Issue tracker to use (`github-issues`, `beads`, `custom`)                                                              |
| `--create-label`          | No       | Interactive prompt           | `true` / `false` — whether to create the `Sandcastle` GitHub label (only with `--issue-tracker github-issues`)         |
| `--build-image`           | No       | Interactive prompt           | `true` / `false` — whether to build the sandbox image now (ignored with `--issue-tracker custom` or a native provider) |
| `--install-template-deps` | No       | Interactive prompt           | `true` / `false` — whether to install template host deps (e.g. `zod` for the planner templates)                        |

## `sandcastle docker build-image`

Rebuilds the Docker image from an existing `.sandcastle/` directory. Use this after modifying the Dockerfile. On Linux/macOS, the build automatically passes `--build-arg AGENT_UID=$(id -u)` and `AGENT_GID=$(id -g)` so the image's `agent` user matches the host UID — this prevents permission errors on image-built files without runtime chown.

| Option         | Required | Default                      | Description                                                                       |
| -------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name                                                                 |
| `--dockerfile` | No       | —                            | Path to a custom Dockerfile (build context will be the current working directory) |

## `sandcastle docker remove-image`

Removes the Docker image.

| Option         | Required | Default                      | Description       |
| -------------- | -------- | ---------------------------- | ----------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name |

## `sandcastle podman build-image`

Builds the Podman image from an existing `.sandcastle/` directory. Use this after modifying the Containerfile.

| Option            | Required | Default                      | Description                                                                          |
| ----------------- | -------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `--image-name`    | No       | `sandcastle:<repo-dir-name>` | Podman image name                                                                    |
| `--containerfile` | No       | —                            | Path to a custom Containerfile (build context will be the current working directory) |

## `sandcastle podman remove-image`

Removes the Podman image.

| Option         | Required | Default                      | Description       |
| -------------- | -------- | ---------------------------- | ----------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Podman image name |
