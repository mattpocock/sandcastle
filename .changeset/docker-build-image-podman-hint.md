---
"@ai-hero/sandcastle": patch
---

`sandcastle docker build-image` in a project scaffolded for podman (it has `.sandcastle/Containerfile` and no Dockerfile) now points you at `sandcastle podman build-image`, or `--dockerfile .sandcastle/Containerfile`, instead of saying native sandboxes need no image.
