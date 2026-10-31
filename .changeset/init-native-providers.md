---
"@ai-hero/sandcastle": minor
---

`sandcastle init` offers the native sandbox providers. The interactive prompt lists the host OS's native provider first and preselects it, marked "(recommended)": `bwrap` on Linux (and WSL2), `seatbelt` on macOS, then Docker and Podman. `--sandbox bwrap|seatbelt|docker|podman` is accepted on any OS. A native provider scaffolds no Dockerfile or Containerfile and has no build-image prompt, `--build-image` flag or build-image next step; the main file imports the chosen provider. Non-interactive `init` still requires `--sandbox`, and `init --sandbox docker` is unchanged.
