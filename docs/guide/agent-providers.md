# Agent providers

> **Agent provider**: A pluggable implementation that builds commands and parses output for a specific **agent**, injected into `run()` via the `agent` option.

Sandcastle ships agent providers for Claude Code, Codex, Pi, Copilot, Cursor and OpenCode: `claudeCode()`, `codex()`, `pi()`, `copilot()`, `cursor()` and `opencode()`, all exported from `@ai-hero/sandcastle`. Each takes a model string and, optionally, provider-specific options:

```typescript
import { run, codex } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: codex("gpt-5.4", { effort: "high" }),
  sandbox: docker(),
  prompt: "Fix issue #42 in this repo.",
});
```

## `ClaudeCodeOptions`

The `claudeCode()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: claudeCode("claude-opus-4-8", { effort: "high" });
```

| Option            | Type                                                                                           | Default | Description                                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effort`          | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`                                      | —       | Claude Code reasoning effort level (`max` is Opus only)                                                                                                                                             |
| `env`             | `Record<string, string>`                                                                       | `{}`    | Environment variables injected by this agent provider                                                                                                                                               |
| `captureSessions` | `boolean`                                                                                      | `true`  | Capture agent session JSONL to host for `claude --resume`                                                                                                                                           |
| `permissionMode`  | `"default"` \| `"acceptEdits"` \| `"plan"` \| `"auto"` \| `"dontAsk"` \| `"bypassPermissions"` | —       | Maps to Claude's `--permission-mode` flag. When set, replaces Sandcastle's default `--dangerously-skip-permissions` on AFK runs. Use `"auto"` for AI-mediated per-tool approve/deny without bypass. |

## `CodexOptions`

The `codex()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: codex("gpt-5.4", { effort: "high" });
```

| Option              | Type                                           | Default | Description                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effort`            | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | —       | Codex reasoning effort level via `model_reasoning_effort`                                                                                                                                                             |
| `env`               | `Record<string, string>`                       | `{}`    | Environment variables injected by this agent provider                                                                                                                                                                 |
| `captureSessions`   | `boolean`                                      | `true`  | Capture Codex rollout JSONL to host for resume                                                                                                                                                                        |
| `approvalsReviewer` | `"user"` \| `"auto_review"`                    | —       | Maps to Codex's `approvals_reviewer` config. When `"auto_review"`, swaps `--dangerously-bypass-approvals-and-sandbox` for `-a on-request -s danger-full-access` so the reviewer agent evaluates each approval prompt. |

## `PiOptions`

The `pi()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: pi("claude-sonnet-4-6", { thinking: "high" });
```

| Option            | Type                                                                     | Default | Description                                              |
| ----------------- | ------------------------------------------------------------------------ | ------- | -------------------------------------------------------- |
| `thinking`        | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | —       | Pi reasoning effort level via the `--thinking` flag      |
| `env`             | `Record<string, string>`                                                 | `{}`    | Environment variables injected by this agent provider    |
| `captureSessions` | `boolean`                                                                | `true`  | Capture pi session JSONL to host for `pi --session <id>` |

Without `thinking`, Sandcastle passes no `--thinking` flag, and pi uses its own default (`medium`). Some models reject that default. With pi 0.73.1, `anthropic/claude-haiku-5-5` fails with a 400 (`"thinking.type.enabled" is not supported for this model`). For a model like that, pass `{ thinking: "off" }`.

## Provider `env`

Both **agent providers** and **sandbox providers** accept an optional `env: Record<string, string>` in their options. These environment variables are merged with the `.sandcastle/.env` resolver output at launch time:

```typescript
await run({
  agent: claudeCode("claude-opus-4-8", {
    env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  }),
  sandbox: docker({
    env: { DOCKER_SPECIFIC_VAR: "value" },
  }),
  prompt: "Fix issue #42",
});
```

**Merge rules:**

- Provider env (agent + sandbox) overrides `.sandcastle/.env` resolver output for shared keys
- Agent provider env and sandbox provider env **must not overlap** — if they share any key, `run()` throws an error
- When `env` is not provided, it defaults to `{}`
- Under `createSandbox()` and `worktree.createSandbox()`, the container starts before any agent is chosen, so each `sandbox.run()` applies its agent's `env` to that run's agent process only. `sandbox.exec()` and hooks don't see it

Environment variables are also resolved automatically from `.sandcastle/.env` and `process.env` — no need to pass them to the API. The required variables depend on the **agent provider** (see `sandcastle init` output for details).

## Related terms

- [Core concepts](./core-concepts.md): the agent
- [Agent sessions](./agent-sessions.md): `captureSessions`, and which providers resume and fork
- [Sandbox providers](./sandbox-providers.md): the sandbox provider's own `env`, and the native sandbox's logins
- [Init](./init.md): choosing an agent during init
- [`run()` reference](./run.md#runoptions): the `agent` option
