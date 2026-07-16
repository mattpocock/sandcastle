---
"@ai-hero/sandcastle": minor
---

Added a GitLab Issues option to `sandcastle init`. Selecting it installs the GitLab CLI (`glab`) in the sandbox image, wires the scaffolded prompts to list, view, and close GitLab issues, generates a `.env.example` with `GITLAB_TOKEN` (plus an optional `GITLAB_HOST` for self-managed instances), and offers to create the `Sandcastle` label via `glab label create`.
