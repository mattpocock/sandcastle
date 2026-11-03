# Getting started

## What is Sandcastle?

A TypeScript library for orchestrating AI coding [agents](./glossary.md#agent), tools such as Claude Code or Codex that read and change your code on their own. Each agent runs in an isolated [sandbox](./glossary.md#sandbox): a container, a VM or an OS process sandbox that limits what the agent can reach, so you can leave it to work.

1. You invoke agents with a single `sandcastle.run()`.
2. Sandcastle handles sandboxing the agent with a configurable [branch strategy](./glossary.md#branch-strategy), which decides where the agent's commits go: onto your current branch, onto a temporary branch it merges back for you, or onto a branch you name.
3. The commits made on the branches get merged back.

Sandcastle is provider-agnostic. It ships with native sandboxes that use your OS's own process sandbox (Bubblewrap on Linux and WSL2, Seatbelt on macOS), image-based providers for Docker and Podman, and cloud providers for Daytona, E2B, Fly.io Sprites, Modal and Vercel, and you can create your own. Great for parallelizing multiple AFK agents, creating review pipelines, or even just orchestrating your own agents.

## Prerequisites

- [Git](https://git-scm.com/)
- A [sandbox provider](./glossary.md#sandbox-provider): the function, such as `bwrap()` or `docker()`, that creates the sandbox and runs the agent in it. You pass it to `run()` as the `sandbox` option. Built-in options:
  - **Native sandboxes (recommended for local development)**: no image to build and no daemon to run. The agent uses the tools already installed on your [host](./glossary.md#host), the machine you run Sandcastle on.
    - `bwrap()` on Linux, and on Windows inside WSL2: needs [Bubblewrap](https://github.com/containers/bubblewrap) (`sudo apt install bubblewrap`, or your distro's equivalent)
    - `seatbelt()` on macOS 14 or later: nothing to install
  - [Docker Desktop](https://www.docker.com/) or [Podman](https://podman.io/): image-based, with a VM boundary on macOS and Windows
  - [Vercel](https://vercel.com/): cloud-based Firecracker microVMs via `@vercel/sandbox`
  - Or [create your own](./sandbox-providers.md#custom-sandbox-providers) using `createBindMountSandboxProvider` or `createIsolatedSandboxProvider`

## Quick start

1. Install the package:

```bash
npm install --save-dev @ai-hero/sandcastle
```

2. Run `npx @ai-hero/sandcastle init`. [Init](./glossary.md#init) is the one-time setup command: it scaffolds a `.sandcastle` directory with all the files needed, lists your OS's native sandbox first, marked "(recommended)", and checks that it works on your machine.

```bash
npx @ai-hero/sandcastle init
```

3. Copy `.sandcastle/.env.example` to `.sandcastle/.env`, then fill in your default values for `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` on your host to get one). To use an Anthropic API key instead, uncomment and fill in `ANTHROPIC_API_KEY`. A native sandbox hides your host's stored logins from the agent, so the agent logs in only through these env vars.

```bash
cp .sandcastle/.env.example .sandcastle/.env
```

4. Run the `.sandcastle/main.mts` file with `npx tsx` (init names it `main.ts` instead when your `package.json` has `"type": "module"`)

```bash
npx tsx .sandcastle/main.mts
```

```typescript
// 4. Run the agent via the JS API
import { run, claudeCode } from "@ai-hero/sandcastle";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";

await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: bwrap(), // seatbelt() on macOS, or docker(), podman(), vercel(), or your own provider
  promptFile: ".sandcastle/prompt.md",
});
```
