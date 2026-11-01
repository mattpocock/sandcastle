# `sandcastle init`

Scaffolds `.sandcastle/` in the user's repo, then optionally creates a GitHub label and builds the image (`src/cli.ts:156`, `src/InitService.ts:1017`).

## Entry point

```bash
npm run -s verify -- sandcastle <run> init --template blank --agent claude-code \
  --model claude-haiku-5-5 --sandbox docker --issue-tracker github-issues \
  --create-label false --build-image true
```

The agent's shell has no TTY, so every prompt must come as a flag. A missing one fails with `<flag> is required in non-interactive mode (no TTY detected).` (`src/cli.ts:233-239`). The prompts themselves (a select, a confirm) need a terminal and are unverifiable here.

| Flag                      | Values                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `--template`              | blank, simple-loop, sequential-reviewer, parallel-planner, parallel-planner-with-review              |
| `--agent`                 | claude-code, pi, codex, cursor, opencode, copilot                                                    |
| `--model`                 | any id. Without it, the agent's default, never the cheapest. Pass `doctor`'s model; options by hand. |
| `--sandbox`               | docker, podman (`src/InitService.ts:595-608`). Vercel and Daytona exist only in the JS API           |
| `--issue-tracker`         | github-issues, beads, custom                                                                         |
| `--create-label`          | true/false (github-issues only)                                                                      |
| `--build-image`           | true/false (skipped for custom)                                                                      |
| `--install-template-deps` | true/false (planner templates, when zod is absent)                                                   |
| `--image-name`            | overrides `sandcastle:<dir>`. Keep the run id in it, or cleanup can't find the image                 |

There is no package-manager flag. It is detected from `packageManager`, then the lockfile, then npm (`src/InitService.ts:95-130`).

## Proof

- **Exit 0** and `Init complete! Image built successfully.`, or `Init complete! Run \`sandcastle docker build-image\`…`when`--build-image false` (`src/cli.ts:487-520`).
- **Files:**
  - `.sandcastle/main.ts` when the project's package.json has `"type": "module"`, which a world's does; otherwise `main.mts` (`src/InitService.ts:996-1015`).
  - `.sandcastle/Dockerfile`, or `Containerfile` for podman.
  - `.sandcastle/.gitignore` holding `.env`, `logs/`, `worktrees/`.
  - `.sandcastle/.env.example`: the agent's keys, then the tracker's.
  - The template's prompt files.
- **The main file** calls the chosen factory with the chosen model. `init` rewrites every `factory("…")` model to the one `--model` gives, so a template's per-phase models collapse into one (`src/InitService.ts:764-815`).
- **Re-running** on an existing `.sandcastle/` fails with `.sandcastle/ directory already exists…` (`src/InitService.ts:1036`).

## Templates

| Template                       | What the main file does                                                                                                                                                                    | Proof once it runs                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `blank`                        | One `run()` with `promptFile: "./.sandcastle/prompt.md"`, head strategy (bind-mount default)                                                                                               | The agent's commit on the checked-out branch                                            |
| `simple-loop`                  | `maxIterations: 3`, merge-to-head, `copyToWorktree: ["node_modules"]`, `onSandboxReady: npm install`. The prompt lists issues and wants `RALPH:` commits and `<promise>COMPLETE</promise>` | `RALPH:` commits merged to HEAD; no `sandcastle/*` branch remains                       |
| `sequential-reviewer`          | Per iteration: `createSandbox` on `sandcastle/sequential-reviewer/<Date.now()>`, an implementer run, then a reviewer run                                                                   | Logs `Implementation complete on branch:`, `Review complete.`; the branch holds commits |
| `parallel-planner`             | A planner `run` with `Output.object` (zod), parallel implementer runs on `branch` strategy, then a merger run                                                                              | Logs `Execution complete. N branch(es) with commits:`, `Branches merged.`               |
| `parallel-planner-with-review` | As above, with each issue's implementer and reviewer sharing one `createSandbox`                                                                                                           | As above                                                                                |

Every template except `blank` needs issues from its tracker. A github-issues run reads real GitHub, which a world doesn't isolate: use `beads`, or a claim that stops before listing issues.

## Issue trackers

- **github-issues:** the prompts use `gh issue list --label Sandcastle …`, `gh issue view`, `gh issue close`. The Dockerfile installs `gh`, and `.env.example` gains `GH_TOKEN=`. `--create-label true` runs `gh label create "Sandcastle" … 2>/dev/null` against the real repo, with errors hidden (`src/cli.ts:399-417`). Never pass true from a world: it writes to whichever GitHub repo `gh` resolves.
- **beads:** `bd ready --json`, `bd show`, `bd close`. The Dockerfile installs a pinned bd release (`ARG BEADS_VERSION`). No env lines. Every sandbox call in `main` gets `sandboxOptions`: a mount of the host's `.beads/` plus `BEADS_DIR`, so worktree sandboxes share the host database. Recipe for a world: run `bd init` and `bd create "<title>" -d "<body>"` on the host first, with a host `bd` of the same version as the image (download the release binary into the world if the host's differs). Proof: the host `bd list --all` shows the issue closed after the run.
- **custom:** writes `.sandcastle/SETUP_ISSUE_TRACKER.md` and skips the build. Listing issues fails on purpose with `No issue tracker configured…`.
- **`--create-label false`** strips ` --label Sandcastle` from every `.sandcastle/*.md` (`src/InitService.ts:822-848`). Proof: `grep -r -- "--label Sandcastle" .sandcastle` finds nothing.
