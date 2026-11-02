# Hooks

> **Host hook**: A lifecycle hook that runs on the **host** machine, not inside the **sandbox**. Host hooks are `{ command: string }` — no `sudo`, no `cwd`.

> **Sandbox hook**: A lifecycle hook that runs inside the **sandbox** container. Sandbox hooks are `{ command: string; sudo?: boolean }`.

Pass `hooks` to `run()`. Here a sandbox hook installs dependencies before the agent starts:

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
  hooks: {
    host: {
      onSandboxReady: [{ command: "echo sandbox is up" }],
    },
    sandbox: {
      onSandboxReady: [{ command: "npm install", timeoutMs: 300_000 }],
    },
  },
});
```

Hooks are grouped by **where** they run — `host` (on the developer's machine) or `sandbox` (inside the sandbox):

```ts
hooks: {
  host: {
    onWorktreeReady: [{ command: "cp .env.example .env" }],
    onSandboxReady:  [{ command: "echo sandbox is up" }],
  },
  sandbox: {
    onSandboxReady: [
      { command: "npm install", timeoutMs: 300_000 },
      { command: "apt-get install -y ffmpeg", sudo: true },
    ],
  },
}
```

| Hook                     | Runs on | When                                         | Working directory                           |
| ------------------------ | ------- | -------------------------------------------- | ------------------------------------------- |
| `host.onWorktreeReady`   | Host    | After `copyToWorktree`, before sandbox start | Worktree path (host repo root under `head`) |
| `host.onSandboxReady`    | Host    | After sandbox is up                          | Worktree path (host repo root under `head`) |
| `sandbox.onSandboxReady` | Sandbox | After sandbox is up                          | Sandbox repo directory                      |

**Ordering:** `copyToWorktree` -> `host.onWorktreeReady` (sequential) -> sandbox created -> `host.onSandboxReady` + `sandbox.onSandboxReady` (parallel).

- **Host hooks** accept `{ command: string; timeoutMs?: number }` — no `sudo`, no `cwd`. Use `cd` or inline env in the command string.
- **Sandbox hooks** accept `{ command: string; sudo?: boolean; timeoutMs?: number }` — set `sudo: true` to run the whole command as root. On `docker` and `podman` this runs it as the container's root user, so the image needs no `sudo` binary; on `daytona` and `vercel` it uses the sandbox's own `sudo`. `sudo: true` isn't available on the native providers (`bwrap`, `seatbelt`), which have no root: the hook fails, naming the provider and pointing to `docker()`. Install system packages on your host instead.
- **`timeoutMs`** overrides the default 60 s per-hook timeout. Useful for long-running setup commands like dependency installs (e.g. `timeoutMs: 300_000` for 5 minutes).
- Within each hook point, sandbox hooks run in parallel; host hooks within `onSandboxReady` also run in parallel with sandbox hooks. `host.onWorktreeReady` hooks run sequentially in declared order.
- If any hook exits non-zero, setup fails fast.
- When a `signal` is passed to `run()`, it is threaded to all hooks — aborting the signal cancels any in-flight hook commands.

## Related terms

- [Core concepts](./core-concepts.md): the host and the sandbox
- [Branch strategies](./branch-strategies.md): the worktree that host hooks run in
- [Sandbox providers](./sandbox-providers.md): which providers support `sudo: true`
- [Prompts](./prompts.md#dynamic-context-with--command-): shell expressions, which run after sandbox hooks
- [`run()` reference](./run.md#runoptions): the `hooks` option
