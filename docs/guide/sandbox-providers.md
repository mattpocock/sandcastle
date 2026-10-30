# Sandbox providers

Sandcastle uses a `SandboxProvider` to create isolated environments. The `sandbox` option on `run()`, `interactive()`, and `createSandbox()` accepts any provider, including `noSandbox()` — opt in to running the agent directly on the host when container isolation is undesired. Built-in providers:

| Provider   | Import path                                | Type       | Accepted by                                 |
| ---------- | ------------------------------------------ | ---------- | ------------------------------------------- |
| Docker     | `@ai-hero/sandcastle/sandboxes/docker`     | Bind-mount | `run()`, `createSandbox()`, `interactive()` |
| Podman     | `@ai-hero/sandcastle/sandboxes/podman`     | Bind-mount | `run()`, `createSandbox()`, `interactive()` |
| Vercel     | `@ai-hero/sandcastle/sandboxes/vercel`     | Isolated   | `run()`, `createSandbox()`, `interactive()` |
| No-sandbox | `@ai-hero/sandcastle/sandboxes/no-sandbox` | None       | `run()`, `createSandbox()`, `interactive()` |

Worktree methods (`wt.run()`, `wt.interactive()`, `wt.createSandbox()`) accept the same providers as their top-level counterparts. `wt.interactive()` defaults to `noSandbox()` when no sandbox is specified.

```typescript
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { vercel } from "@ai-hero/sandcastle/sandboxes/vercel";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

// Docker, Podman, and Vercel are interchangeable in run() and createSandbox():
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "...",
});

// No-sandbox runs the agent directly on the host — accepted by run(),
// createSandbox(), and interactive(). Skips container isolation entirely:
await interactive({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: noSandbox(),
  prompt: "...", // optional — omit to launch the TUI with no initial prompt
  cwd: "/path/to/other-repo", // optional — defaults to process.cwd()
});
```

You can also [create your own provider](./custom-sandbox-providers.md) using `createBindMountSandboxProvider` or `createIsolatedSandboxProvider`.
