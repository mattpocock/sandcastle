---
"@ai-hero/sandcastle": patch
---

Add GitLab Issues as a backlog manager option for `sandcastle init`.

Selecting `gitlab-issues` scaffolds prompts that drive the `glab` CLI, installs `glab` in the sandbox Dockerfile, and writes a `GITLAB_TOKEN` (plus optional `GITLAB_HOST`) entry into `.env.example`. `glab issue close` does not accept a comment, so `CLOSE_TASK_COMMAND` is now `readonly string[]` and renders as a `&&`-joined shell pipeline (`glab issue note <ID> -m "..." && glab issue close <ID>`); the GitHub and Beads entries also become single-element arrays.

A new `--backlog-manager <name>` flag on `sandcastle init` skips the interactive selection.
