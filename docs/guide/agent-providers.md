# Agent providers

Sandcastle ships [agent providers](./glossary.md#agent-provider) for Claude Code, Codex, Pi, Copilot, Cursor, OpenCode and CodeBuddy: `claudeCode()`, `codex()`, `pi()`, `copilot()`, `cursor()`, `opencode()` and `codebuddy()`, all exported from `@ai-hero/sandcastle`. Each takes a model string and, optionally, provider-specific options:

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
| `captureSessions` | `boolean`                                                                                      | `true`  | Capture the [agent](./glossary.md#agent)'s session JSONL to [host](./glossary.md#host) for `claude --resume`                                                                                        |
| `permissionMode`  | `"default"` \| `"acceptEdits"` \| `"plan"` \| `"auto"` \| `"dontAsk"` \| `"bypassPermissions"` | —       | Maps to Claude's `--permission-mode` flag. When set, replaces Sandcastle's default `--dangerously-skip-permissions` on AFK runs. Use `"auto"` for AI-mediated per-tool approve/deny without bypass. |

## `CodexOptions`

The `codex()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: codex("gpt-5.4", { effort: "high" });
```

| Option              | Type                                                      | Default | Description                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effort`            | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | —       | Codex reasoning effort level via `model_reasoning_effort`                                                                                                                                                              |
| `env`               | `Record<string, string>`                                  | `{}`    | Environment variables injected by this agent provider                                                                                                                                                                  |
| `captureSessions`   | `boolean`                                                 | `true`  | Capture Codex rollout JSONL to host for resume                                                                                                                                                                         |
| `approvalsReviewer` | `"user"` \| `"auto_review"`                               | —       | Maps to Codex's `approvals_reviewer` config. When `"auto_review"`, swaps `--dangerously-bypass-approvals-and-sandbox` for `-a on-request -s danger-full-access` so the reviewer agent evaluates each approval request. |

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

## `CodebuddyOptions`

The `codebuddy()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: codebuddy("deepseek-v4.1-flash", {
  permissionMode: "bypassPermissions",
});
```

| Option            | Type                                                                                           | Default | Description                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `permissionMode`  | `"default"` \| `"acceptEdits"` \| `"plan"` \| `"auto"` \| `"dontAsk"` \| `"bypassPermissions"` | —       | Maps to CodeBuddy's `--permission-mode` flag. When set, replaces Sandcastle's default `--dangerously-skip-permissions` on AFK runs. |
| `env`             | `Record<string, string>`                                                                       | `{}`    | Environment variables injected by this agent provider                                                                               |
| `captureSessions` | `boolean`                                                                                      | `true`  | Capture the CodeBuddy session JSONL to host for `codebuddy --resume`                                                                |

The `codebuddy()` provider also injects `CODEBUDDY_IS_SANDBOX=1` by default: CodeBuddy's `--dangerously-skip-permissions` still asks about HIGH/CRITICAL-risk tools, and this environment variable upgrades it to a full pass so an unattended run cannot stall waiting for approval. Pass your own `env.CODEBUDDY_IS_SANDBOX` to opt out.

Auth differs by platform. A key from the international platform (www.codebuddy.ai) authenticates headless runs through `CODEBUDDY_API_KEY` with no further setup. Keys from Tencent's CN platform (copilot.tencent.com) do not, and the CLI's login state lives under the home dir a [sandbox](./glossary.md#sandbox) replaces. On the CN platform (verified end to end on Docker):

1. Use the native CN build of the CLI (`codebuddy install stable`), not the npm package — the npm build authenticates CN sessions against www.codebuddy.ai, which rejects them. bwrap picks the host's build up from `PATH` automatically; a Docker image must install the native build.
2. Mount the login state into the sandbox: `~/.local/share/CodeBuddyExtension` (read-only — the CLI refreshes tokens on 401 and a writable mount lets a mis-resolved endpoint rewrite the host's auth) and `~/.codebuddy` (read-write — session capture writes there).
3. Pin the CN product line with `env: { ACC_PRODUCT_CONFIG_PATH: "/path/to/cn-product.json" }` on the provider, the config file mounted read-only into the sandbox. Without it the CLI syncs the international product config and the session is rejected; `CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT: "internal"` is a harmless belt-and-braces alongside.

Do not set `CODEBUDDY_IS_SANDBOX=1` with a login session — it switches the CLI to a sandboxed auth route the session cannot serve; set it via `env` only with `CODEBUDDY_API_KEY`, when AFK runs need the HIGH/CRITICAL full pass.

## Provider `env`

Both **agent providers** and **[sandbox providers](./glossary.md#sandbox-provider)** accept an optional `env: Record<string, string>` in their options. These environment variables are merged with the `.sandcastle/.env` resolver output at launch time:

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

- Provider env (agent + [sandbox](./glossary.md#sandbox)) overrides `.sandcastle/.env` resolver output for shared keys
- Agent provider env and sandbox provider env **must not overlap** — if they share any key, `run()` throws an error
- When `env` is not provided, it defaults to `{}`
- Under `createSandbox()` and `worktree.createSandbox()`, the container starts before any agent is chosen, so each `sandbox.run()` applies its agent's `env` to that run's agent process only. `sandbox.exec()` and hooks don't see it

Environment variables are also resolved automatically from `.sandcastle/.env` and `process.env` — no need to pass them to the API. The required variables depend on the **agent provider** (see `sandcastle init` output for details).

## Related terms

- [Core concepts](./core-concepts.md): the agent
- [Agent sessions](./agent-sessions.md): `captureSessions`, and which providers resume and fork
- [Sandbox providers](./sandbox-providers.md): the sandbox provider's own `env`, and the native sandbox's logins
- [Init](./init.md): choosing an agent during [init](./glossary.md#init)
- [`run()` reference](./run.md#runoptions): the `agent` option
