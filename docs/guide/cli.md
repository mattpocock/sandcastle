# CLI commands

## `sandcastle init`

Scaffolds the `.sandcastle/` [config directory](./glossary.md#config-directory) with the `blank` template. This is the first command you run in a new repo.

See [Init](./init.md) for what [init](./glossary.md#init) asks, checks and writes.

| Option       | Required | Default               | Description                                                                                                                                                 |
| ------------ | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent`    | No       | Asked interactively   | [Agent](./glossary.md#agent) to use (`claude-code`, `pi`, `codex`, `cursor`, `opencode`, `copilot`)                                                         |
| `--model`    | No       | Agent's default model | Model to use (e.g. `claude-sonnet-4-6`). Defaults to agent's default                                                                                        |
| `--sandbox`  | No       | Asked interactively   | [Sandbox provider](./glossary.md#sandbox-provider) to use (`bwrap`, `seatbelt`, `docker`, `podman`, `daytona`, `e2b`, `modal`, `sprites`, `vercel`, `host`) |
| `--template` | No       | `blank`               | Template to scaffold. `blank` is the only one                                                                                                               |

## `sandcastle docker build-image`

Rebuilds the Docker image from an existing `.sandcastle/` directory. Use this after modifying the Dockerfile. On Linux/macOS, the build automatically passes `--build-arg AGENT_UID=$(id -u)` and `AGENT_GID=$(id -g)` so the image's `agent` user matches the [host](./glossary.md#host) UID — this prevents permission errors on image-built files without runtime chown.

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
