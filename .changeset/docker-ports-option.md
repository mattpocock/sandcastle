---
"@ai-hero/sandcastle": patch
---

Add `ports` option to the `docker()` sandbox provider.

When an agent starts a web server inside the sandbox container, the container is created without port mappings by default, so the host cannot reach the service. The new `ports` option accepts a list of port numbers and maps each one as `-p <port>:<port>` in the `docker run` command.

```ts
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker({ ports: [3000, 5173] }),
  promptFile: ".sandcastle/prompt.md",
});
```
