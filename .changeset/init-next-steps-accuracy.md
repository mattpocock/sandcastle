---
"@ai-hero/sandcastle": patch
---

`sandcastle init`'s next steps now reflect what init did: the run step uses the detected package manager (`pnpm run sandcastle`, `yarn run sandcastle`, `bun run sandcastle`), the zod step is skipped once zod is installed or already declared, and the `onSandboxReady` note names the detected install command.
