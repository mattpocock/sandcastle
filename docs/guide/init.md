# Init

> **Init**: The CLI command that scaffolds the **config directory** in a **host** repo.

> **Config directory**: The `.sandcastle/` directory in a **host** repo containing sandbox configuration.

> **Issue tracker**: A pluggable source of **tasks** for the **agent**, selected during **init** (e.g. GitHub Issues, Beads). Used loosely -- Beads is a dependency-aware task tracker rather than a literal issue tracker, but "issue tracker" is the umbrella term.

> **Template argument**: A named `{{KEY}}` placeholder in a scaffold template (Dockerfile, prompt `.md` file) that **init** replaces with a value derived from the user's choices.

Run init once in a new repo. It asks for each choice, or takes them all as flags:

```bash
npx @ai-hero/sandcastle init

# Or, non-interactively:
npx @ai-hero/sandcastle init --agent claude-code --sandbox docker \
  --issue-tracker github-issues --template simple-loop \
  --create-label true --build-image true
```

## What init does

You choose a sandbox provider during init. The prompt lists your OS's native sandbox first, preselected and marked "(recommended)": `bwrap` on Linux and WSL2, `seatbelt` on macOS. Docker and Podman follow. On Windows outside WSL2, only Docker and Podman are offered.

- **A native provider** (`bwrap`, `seatbelt`) writes no Dockerfile and skips the build-image step. Init checks your host: it warns, with the exact command to run, when the sandbox tool doesn't work yet (for example `bwrap` isn't installed) or the chosen agent's CLI isn't on your `PATH`, and still writes the files. With Beads, the main file mounts your `.beads/` at its host path and the agent uses your host's `bd`. With GitHub Issues, put a `GH_TOKEN` in `.sandcastle/.env`, because the sandbox hides your host's `gh` login.
- **Docker** writes a `Dockerfile`; **Podman** writes a `Containerfile` and uses `sandcastle podman build-image` for the build step.

Init detects your host package manager (npm, pnpm, yarn, or bun) from a `packageManager` field or lockfile, defaulting to npm. Templates whose `main` file imports a host dependency — the planner templates import [Zod](https://zod.dev) for their `<plan>` output schema — prompt you to install it with that package manager when it isn't already in your `package.json`, so the first `npx tsx .sandcastle/main.ts` doesn't fail with `ERR_MODULE_NOT_FOUND`.

Every interactive prompt has a paired `--flag` so the entire init can run non-interactively (e.g. in CI or a scripted setup). When stdin is not a TTY, init checks every flag it would otherwise prompt for before it writes anything, and fails with one error naming all the missing flags rather than wedging on a prompt or leaving a half-written `.sandcastle/` behind.

Creates the following files:

```
.sandcastle/
├── Dockerfile      # Sandbox environment (Docker only; Containerfile for Podman; none for bwrap/seatbelt)
├── main.mts        # Agent entry point (main.ts in an ESM package)
├── prompt.md       # Agent instructions
├── .env.example    # Token placeholders
└── .gitignore      # Ignores .env, logs/, worktrees/
```

Errors if `.sandcastle/` already exists to prevent overwriting customizations.

Every flag is listed under [`sandcastle init`](./cli.md#sandcastle-init).

## Config directory (`.sandcastle/`)

All per-repo sandbox configuration lives in `.sandcastle/`. Run `sandcastle init` to create it.

## Templates

`sandcastle init` prompts you to choose a sandbox provider (your OS's native sandbox, Docker or Podman), an issue tracker (GitHub Issues, Beads, or Custom), and a template, which scaffolds a ready-to-use prompt and `main.mts` suited to a specific workflow. If your project's `package.json` has `"type": "module"`, the file will be named `main.ts` instead. Choosing **Custom** scaffolds the project in a deliberately broken-until-configured state plus a `.sandcastle/SETUP_ISSUE_TRACKER.md` prompt you feed to your coding agent, which wires up your own tracker by editing the scaffolded files in place. Five templates are available:

| Template                       | Description                                                               |
| ------------------------------ | ------------------------------------------------------------------------- |
| `blank`                        | Bare scaffold — write your own prompt and orchestration                   |
| `simple-loop`                  | Picks issues one by one and closes them                                   |
| `sequential-reviewer`          | Implements issues one by one, with a code review step after each          |
| `parallel-planner`             | Plans parallelizable issues, executes on separate branches, then merges   |
| `parallel-planner-with-review` | Plans parallelizable issues, executes with per-branch review, then merges |

Select a template during `sandcastle init` when prompted, or re-run init in a fresh repo to try a different one.

## Template arguments

The scaffold templates contain template arguments, and init replaces them as it writes the files: for example, `{{ISSUE_TRACKER_TOOLS}}` in the Dockerfile becomes the setup for the issue tracker you chose. They use the same `{{KEY}}` syntax as [prompt arguments](./prompts.md#prompt-arguments-with-key), but init fills them in once, when it writes the file.

## Custom Dockerfile

The `.sandcastle/Dockerfile` controls the sandbox environment. The default template installs:

- **Node.js 22** (base image)
- **git**, **curl**, **jq** (system dependencies)
- **GitHub CLI** (`gh`)
- **Claude Code CLI**
- A non-root `agent` user (required — Claude runs as this user)

When customizing the Dockerfile, ensure you keep:

- A non-root user (the default `agent` user) for Claude to run as
- `git` (required for commits and branch operations)
- `gh` (required for issue fetching)
- Claude Code CLI installed and on PATH

Add your project-specific dependencies (e.g., language runtimes, build tools) to the Dockerfile as needed.

## Related terms

- [Sandbox providers](./sandbox-providers.md): the providers init offers, and build-image
- [Agent providers](./agent-providers.md): the agents init offers
- [Prompts](./prompts.md): the scaffolded `prompt.md`
- [Iterations](./iterations.md): an iteration works on one task from the issue tracker
- [CLI commands](./cli.md): every `sandcastle init` flag
