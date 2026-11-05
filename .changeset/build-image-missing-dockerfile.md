---
"@ai-hero/sandcastle": patch
---

`sandcastle docker build-image` and `sandcastle podman build-image` now say when the project has no Dockerfile (or Containerfile), or when the `--dockerfile`/`--containerfile` path does not exist, instead of reporting a Docker failure with "Is Docker running?". Native sandboxes don't need an image.
