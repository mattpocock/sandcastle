# Init

Run [init](./glossary.md#init) once in a new repo. It asks which [agent](./glossary.md#agent) and which [sandbox provider](./glossary.md#sandbox-provider) you want, or takes both as flags:

```bash
npx @ai-hero/sandcastle init

# Or, non-interactively:
npx @ai-hero/sandcastle init --agent claude-code --sandbox docker
```

## What init does

Init scaffolds one template, `blank`: a main file that creates one [sandbox](./glossary.md#sandbox), runs one [agent session](./glossary.md#agent-session) in it with your [prompt](./glossary.md#prompt), prints the agent's final message, and closes the sandbox. You build your own workflow on it.

You choose a sandbox provider during init. Init lists your OS's native sandbox first, preselected and marked "(recommended)": `bwrap` on Linux and WSL2, `seatbelt` on macOS. Docker, Podman, Daytona, E2B, Modal, Sprites, Vercel and `host` (no isolation) follow. On Windows outside WSL2, there is no native sandbox to offer.

- **A provider that runs your [host](./glossary.md#host)'s own programs** (`bwrap`, `seatbelt`, `host`): init warns, with the exact command to run, when the sandbox tool doesn't work yet (for example `bwrap` isn't installed) or the chosen agent's CLI isn't on your `PATH`, and still writes the files.
- **Docker and Podman** run an image you bring, with Node, git and the agent's CLI in it. Init writes no Dockerfile and builds nothing: put your image's name in the main file, where it says `my-agent-image`.
- **A remote provider** (Daytona, E2B, Modal, Sprites, Vercel) needs its vendor's SDK installed beside Sandcastle. Init prints the install command for your package manager (npm, pnpm, yarn or bun, detected from a `packageManager` field or lockfile), unless your `package.json` already has it. Its credentials go in `.sandcastle/.env`, and the main file passes them to the provider, not to the sandbox.

Every question has a paired `--flag`, so init can run non-interactively (e.g. in CI or a scripted setup). When stdin is not a TTY, init checks `--agent` and `--sandbox` before it writes anything, and fails with one error naming every missing flag.

Creates the following files:

```
.sandcastle/
├── main.mts        # Creates the sandbox and runs one session (main.ts in an ESM package)
├── prompt.md       # The agent's prompt
├── .env.example    # The agent's key, and the provider's credentials
└── .gitignore      # Ignores .env
```

Errors if `.sandcastle/` already exists to prevent overwriting customizations.

Every flag is listed under [`sandcastle init`](./cli.md#sandcastle-init).

## Config directory (`.sandcastle/`)

All per-repo sandbox configuration lives in `.sandcastle/`. Run `sandcastle init` to create it.

## The main file

The scaffolded main file is plain TypeScript you run with `npx tsx .sandcastle/main.mts`, from your repo root. It:

1. Loads `.sandcastle/.env` itself, because Sandcastle reads no env file. The sandbox gets exactly the env the main file passes it; a remote provider's credentials are kept out of it.
2. Creates the sandbox with `await using`, so it is closed however the file exits.
3. Reads `.sandcastle/prompt.md`, drops its HTML comments, and runs each `` !`command` `` left in it inside the sandbox, putting the command's output in its place.
4. Runs one session with the agent and model you chose, and prints the agent's final message.

The sandbox starts empty: clone your repo into it with a setup `sandbox.exec(...)` before the session (the main file has an example).

`--template blank` is the only template. The 0.x templates (`simple-loop`, `sequential-reviewer`, `parallel-planner` and `parallel-planner-with-review`) were removed in 1.0.0, and init says so if you ask for one.

## Related terms

- [Sandbox providers](./sandbox-providers.md): the providers init offers
- [Agent providers](./agent-providers.md): the agents init offers
- [Prompts](./prompts.md): the scaffolded `prompt.md`
- [CLI commands](./cli.md): every `sandcastle init` flag
