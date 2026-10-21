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

Sandcastle is provider-agnostic — it ships with built-in providers for Docker, Podman, and Vercel, and you can create your own. Great for parallelizing multiple AFK agents, creating review pipelines, or even just orchestrating your own agents.

## Documentation

The docs live in [`docs/guide`](./docs/guide), one page per topic, and are published at [aihero.dev/sandcastle](https://www.aihero.dev/sandcastle).

- [Getting started](./docs/guide/getting-started.md): prerequisites and a quick start
- Guides: [Sandbox providers](./docs/guide/sandbox-providers.md), [How it works](./docs/guide/how-it-works.md), [Prompts](./docs/guide/prompts.md), [Configuration](./docs/guide/configuration.md)
- Reference: [API](./docs/guide/api.md), [CLI commands](./docs/guide/cli-commands.md), [Custom sandbox providers](./docs/guide/custom-sandbox-providers.md)

## Development

```bash
npm install
npm run build    # Bundle with tsup
npm test         # Run tests with vitest
npm run typecheck # Type-check
```

## License

MIT
