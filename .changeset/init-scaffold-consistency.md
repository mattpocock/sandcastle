---
"@ai-hero/sandcastle": patch
---

`sandcastle init` now scaffolds a project consistent with the options it was given. `--image-name` is written into the scaffolded main file (`docker({ imageName })` / `podman({ imageName })`), so the first run uses the image init built rather than the default-named one; the "build later" hint and the custom tracker's setup doc include it too. The opencode and copilot Dockerfiles no longer carry a literal `${SANDBOX_REPO_DIR}` in their comments. `init --agent copilot` declares `COPILOT_GITHUB_TOKEN` instead of `GITHUB_TOKEN`, which the github-issues tracker's `GH_TOKEN` would otherwise shadow.
