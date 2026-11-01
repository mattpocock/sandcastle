<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-ondark_2x.png">
    <source media="(prefers-color-scheme: light)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png">
    <img alt="Sandcastle" src="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png" height="200" style="margin-bottom: 20px;">
  </picture>
</div>

## What is Sandcastle?

A TypeScript library for orchestrating AI coding agents in isolated sandboxes:

1. You invoke agents with a single `sandcastle.run()`.
2. Sandcastle handles sandboxing the agent with a configurable branch strategy.
3. The commits made on the branches get merged back.

Sandcastle is provider-agnostic. It ships with native sandboxes that use your OS's own process sandbox (Bubblewrap on Linux and WSL2, Seatbelt on macOS), image-based providers for Docker and Podman, and cloud providers for Vercel and Daytona, and you can create your own. Great for parallelizing multiple AFK agents, creating review pipelines, or even just orchestrating your own agents.

## Documentation

The docs live in [`docs/guide`](./docs/guide), one page per glossary term (see [`GLOSSARY.md`](./GLOSSARY.md)), and are published at [aihero.dev/sandcastle](https://www.aihero.dev/sandcastle).

- [Getting started](./docs/guide/getting-started.md): prerequisites and a quick start
- Core: [Core concepts](./docs/guide/core-concepts.md)
- Sandboxes: [Sandbox providers](./docs/guide/sandbox-providers.md)
- Branching: [Branch strategies](./docs/guide/branch-strategies.md)
- Agents: [Agent providers](./docs/guide/agent-providers.md), [Agent sessions](./docs/guide/agent-sessions.md)
- Execution: [Iterations](./docs/guide/iterations.md), [Structured output](./docs/guide/structured-output.md)
- Prompts: [Prompts](./docs/guide/prompts.md)
- Hooks: [Hooks](./docs/guide/hooks.md)
- Init: [Init](./docs/guide/init.md)
- Display: [Run logs](./docs/guide/run-logs.md)
- Reference: [`run()` and `createSandbox()`](./docs/guide/run.md), [CLI commands](./docs/guide/cli.md)

## Development

```bash
npm install
npm run build    # Bundle with tsup
npm test         # Run tests with vitest
npm run typecheck # Type-check
```

## License

MIT
