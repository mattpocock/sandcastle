---
"@ai-hero/sandcastle": patch
---

Add `ports` option to the `docker()` sandbox provider.

When an agent starts a web server inside the sandbox container, the container is created without port mappings by default, so the host cannot reach the service. The new `ports` option maps ports via `-p` flags in the `docker run` command.

Each entry is either a `number` (symmetric `port:port`) or a `string` (explicit `hostPort:containerPort`):

```ts
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Symmetric — same port on host and in container
// Works for any language/framework: Python, Rust, Ruby, Node, etc.
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker({ ports: [3000, 8000, 4321] }),
  promptFile: ".sandcastle/prompt.md",
});

// Asymmetric — host port 3001 maps to container port 3000
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker({ ports: ["3001:3000"] }),
  promptFile: ".sandcastle/prompt.md",
});
```

