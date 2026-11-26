---
"@ai-hero/sandcastle": minor
---

`sandcastle init` scaffolds one template, a v1 `blank`: a main file that creates a sandbox with `createSandbox` on the chosen provider, runs one session with the chosen agent and `.sandcastle/prompt.md`, prints the agent's final message, and closes the sandbox (`await using`). It loads `.sandcastle/.env` itself and passes the sandbox exactly that env, keeping a remote provider's credentials out of it, and runs the prompt's `` !`command` `` expressions in the sandbox before the session.

Init now offers every v1 sandbox provider (`bwrap`, `seatbelt`, `docker`, `podman`, `daytona`, `e2b`, `modal`, `sprites`, `vercel` and `host`), and for a remote one prints the command that installs its SDK.

Removed: the `simple-loop`, `sequential-reviewer`, `parallel-planner` and `parallel-planner-with-review` templates (`--template` with one of their names fails, saying so), the issue tracker choice with its Beads and Custom scaffolds, the scaffolded Dockerfile and Containerfile, and the `--issue-tracker`, `--create-label`, `--build-image`, `--install-template-deps` and `--image-name` init flags. Init no longer asks which template to use.
