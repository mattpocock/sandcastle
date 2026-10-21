# Getting started

## What is Sandcastle?

A TypeScript library for orchestrating AI coding agents in isolated sandboxes:

1. You invoke agents with a single `sandcastle.run()`.
2. Sandcastle handles sandboxing the agent with a configurable branch strategy.
3. The commits made on the branches get merged back.

Sandcastle is provider-agnostic — it ships with built-in providers for Docker, Podman, and Vercel, and you can create your own. Great for parallelizing multiple AFK agents, creating review pipelines, or even just orchestrating your own agents.

## Prerequisites

- [Git](https://git-scm.com/)
- A sandbox provider — Sandcastle needs an isolated environment to run agents in. Built-in options:
  - [Docker Desktop](https://www.docker.com/) — most common for local development
  - [Podman](https://podman.io/) — rootless alternative to Docker
  - [Vercel](https://vercel.com/) — cloud-based Firecracker microVMs via `@vercel/sandbox`
  - Or [create your own](./custom-sandbox-providers.md) using `createBindMountSandboxProvider` or `createIsolatedSandboxProvider`

## Quick start

1. Install the package:

```bash
npm install --save-dev @ai-hero/sandcastle
```

2. Run `npx @ai-hero/sandcastle init`. This scaffolds a `.sandcastle` directory with all the files needed.

```bash
npx @ai-hero/sandcastle init
```

3. Copy `.sandcastle/.env.example` to `.sandcastle/.env`, then fill in your default values for `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` on your host to get one). To use an Anthropic API key instead, uncomment and fill in `ANTHROPIC_API_KEY`.

```bash
cp .sandcastle/.env.example .sandcastle/.env
```

4. Run the `.sandcastle/main.ts` (or `main.mts`) file with `npx tsx`

```bash
npx tsx .sandcastle/main.ts
```

```typescript
// 4. Run the agent via the JS API
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(), // or podman(), vercel(), or your own provider
  promptFile: ".sandcastle/prompt.md",
});
```
