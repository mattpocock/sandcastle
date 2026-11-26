# `sandcastle init`

Scaffolds `.sandcastle/` in the user's repo with the one template, `blank` (`src/cli.ts`, `src/InitService.ts`).

## Entry point

```bash
npm run -s verify -- sandcastle <run> init --agent claude-code \
  --model claude-haiku-5-5 --sandbox bwrap
```

The agent's shell has no TTY, so every prompt must come as a flag. A missing one fails with `<flags> is required in non-interactive mode (no TTY detected).`, naming every missing flag, before anything is written. The prompts themselves (a select) need a terminal and are unverifiable here.

| Flag         | Values                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--agent`    | claude-code, pi, codex, cursor, opencode, copilot                                                                                                                                          |
| `--model`    | any id. Without it, the agent's default, never the cheapest. Pass `doctor`'s model; options by hand.                                                                                       |
| `--sandbox`  | bwrap, seatbelt, docker, podman, daytona, e2b, modal, sprites, vercel, host: one per `./v1/sandboxes/<name>` export (`src/initSandboxProviders.ts`)                                        |
| `--template` | blank, the default. A 0.x name (simple-loop, sequential-reviewer, parallel-planner, parallel-planner-with-review) fails with `The "<name>" template was removed in 1.0.0`, writing nothing |

There is no package-manager flag. It is detected from `packageManager`, then the lockfile, then npm (`src/initPackageManager.ts`), and shows in the next steps' SDK install and `run sandcastle` commands.

## Proof

- **Exit 0** and `Init complete!`, then the numbered next steps.
- **Files:** exactly these in `.sandcastle/`:
  - `main.ts` when the project's package.json has `"type": "module"`, which a world's does; otherwise `main.mts`.
  - `prompt.md`, with the `` !`command` `` example in an HTML comment and no completion signal.
  - `.env.example`: the agent's keys, then the provider's credentials (remote providers only).
  - `.gitignore` holding `.env`.
  - No Dockerfile or Containerfile, for any provider.
- **The main file** imports `createSandbox` and the agent factory from `@ai-hero/sandcastle/v1` and the provider from `@ai-hero/sandcastle/v1/sandboxes/<name>`, loads `.sandcastle/.env` with `parseEnv`, creates the sandbox with `await using`, runs one `sandbox.session` with `<factory>("<model>")`, and prints `result.finalMessage`. A remote provider's credentials are destructured out of the env and passed to the factory.
- **Re-running** on an existing `.sandcastle/` fails with `.sandcastle/ directory already exists…`.

## Running the scaffold

Fill in `.sandcastle/.env`, then `npx tsx .sandcastle/main.ts` from the world's project root. The sandbox starts empty, so add a clone `sandbox.exec` before the session if the prompt needs the repo. Proof: the agent's final message on stdout, and no sandbox left behind (`bwrap`/`host`: no process; docker/podman: no `sandcastle.` labelled container; remote: the vendor dashboard or CLI).

- **docker/podman:** replace `my-agent-image` in the main file with an image that has Node, git and the agent CLI (see `docs/v1/docker.md`).
- **Remote providers:** install the vendor SDK in the world first (init prints the command), and put the credentials in `.sandcastle/.env`.
