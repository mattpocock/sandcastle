# CLI commands

## `sandcastle init`

Scaffolds the `.sandcastle/` config directory and builds the container image. This is the first command you run in a new repo. You choose a sandbox provider (Docker or Podman) during init — selecting Podman writes a `Containerfile` instead of `Dockerfile` and uses `sandcastle podman build-image` for the build step.

Init detects your host package manager (npm, pnpm, yarn, or bun) from a `packageManager` field or lockfile, defaulting to npm. Templates whose `main` file imports a host dependency — the planner templates import [Zod](https://zod.dev) for their `<plan>` output schema — prompt you to install it with that package manager when it isn't already in your `package.json`, so the first `npx tsx .sandcastle/main.ts` doesn't fail with `ERR_MODULE_NOT_FOUND`.

Every interactive prompt has a paired `--flag` so the entire init can run non-interactively (e.g. in CI or a scripted setup). When stdin is not a TTY and a required flag is missing, init fails fast with a clear error rather than wedging on a prompt.

| Option                    | Required | Default                      | Description                                                                                                    |
| ------------------------- | -------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--image-name`            | No       | `sandcastle:<repo-dir-name>` | Docker image name                                                                                              |
| `--agent`                 | No       | Interactive prompt           | Agent to use (`claude-code`, `pi`, `codex`, `cursor`, `opencode`, `copilot`)                                   |
| `--model`                 | No       | Agent's default model        | Model to use (e.g. `claude-sonnet-4-6`). Defaults to agent's default                                           |
| `--sandbox`               | No       | Interactive prompt           | Sandbox provider to use (`docker`, `podman`)                                                                   |
| `--template`              | No       | Interactive prompt           | Template to scaffold (e.g. `blank`, `simple-loop`)                                                             |
| `--issue-tracker`         | No       | Interactive prompt           | Issue tracker to use (`github-issues`, `beads`, `custom`)                                                      |
| `--create-label`          | No       | Interactive prompt           | `true` / `false` — whether to create the `Sandcastle` GitHub label (only with `--issue-tracker github-issues`) |
| `--build-image`           | No       | Interactive prompt           | `true` / `false` — whether to build the sandbox image now (silently ignored with `--issue-tracker custom`)     |
| `--install-template-deps` | No       | Interactive prompt           | `true` / `false` — whether to install template host deps (e.g. `zod` for the planner templates)                |

Creates the following files:

```
.sandcastle/
├── Dockerfile      # Sandbox environment (customize as needed)
├── main.mts        # Agent entry point (main.ts in an ESM package)
├── prompt.md       # Agent instructions
├── .env.example    # Token placeholders
└── .gitignore      # Ignores .env, logs/, worktrees/
```

Errors if `.sandcastle/` already exists to prevent overwriting customizations.

## `sandcastle docker build-image`

Rebuilds the Docker image from an existing `.sandcastle/` directory. Use this after modifying the Dockerfile. On Linux/macOS, the build automatically passes `--build-arg AGENT_UID=$(id -u)` and `AGENT_GID=$(id -g)` so the image's `agent` user matches the host UID — this prevents permission errors on image-built files without runtime chown.

| Option         | Required | Default                      | Description                                                                       |
| -------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name                                                                 |
| `--dockerfile` | No       | —                            | Path to a custom Dockerfile (build context will be the current working directory) |

## `sandcastle docker remove-image`

Removes the Docker image.

| Option         | Required | Default                      | Description       |
| -------------- | -------- | ---------------------------- | ----------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name |

## `sandcastle podman build-image`

Builds the Podman image from an existing `.sandcastle/` directory. Use this after modifying the Containerfile.

| Option            | Required | Default                      | Description                                                                          |
| ----------------- | -------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `--image-name`    | No       | `sandcastle:<repo-dir-name>` | Podman image name                                                                    |
| `--containerfile` | No       | —                            | Path to a custom Containerfile (build context will be the current working directory) |

## `sandcastle podman remove-image`

Removes the Podman image.

| Option         | Required | Default                      | Description       |
| -------------- | -------- | ---------------------------- | ----------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Podman image name |

## `RunOptions`

| Option                     | Type               | Default                       | Description                                                                                                                                                                                                                              |
| -------------------------- | ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                    | AgentProvider      | —                             | **Required.** Agent provider (e.g. `claudeCode("claude-opus-4-8")`, `pi("claude-sonnet-4-6")`, `codex("gpt-5.4")`, `cursor("composer-2")`, `opencode("opencode/big-pickle")`, `copilot("claude-sonnet-4.5")`)                            |
| `sandbox`                  | SandboxProvider    | —                             | **Required.** Sandbox provider (e.g. `docker()`, `podman()`, `docker({ imageName: "sandcastle:local" })`)                                                                                                                                |
| `cwd`                      | string             | `process.cwd()`               | Host repo directory — anchor for `.sandcastle/` artifacts and git operations. Relative paths resolve against `process.cwd()`.                                                                                                            |
| `prompt`                   | string             | —                             | Inline prompt (mutually exclusive with `promptFile`)                                                                                                                                                                                     |
| `promptFile`               | string             | —                             | Path to prompt file (mutually exclusive with `prompt`). Resolves against `process.cwd()`, **not** `cwd`.                                                                                                                                 |
| `maxIterations`            | number             | `1`                           | Maximum iterations to run                                                                                                                                                                                                                |
| `hooks`                    | SandboxHooks       | —                             | Lifecycle hooks (`host.*`, `sandbox.*`)                                                                                                                                                                                                  |
| `name`                     | string             | —                             | Display name for the run, shown as a prefix in log output                                                                                                                                                                                |
| `promptArgs`               | PromptArgs         | —                             | Key-value map for `{{KEY}}` placeholder substitution                                                                                                                                                                                     |
| `branchStrategy`           | BranchStrategy     | per-provider default          | Branch strategy: `{ type: 'head' }`, `{ type: 'merge-to-head' }`, or `{ type: 'branch', branch: '…' }`                                                                                                                                   |
| `copyToWorktree`           | string[]           | —                             | Host-relative file paths to copy into the sandbox before start (not supported with `branchStrategy: { type: 'head' }`)                                                                                                                   |
| `logging`                  | object             | file (auto-generated)         | `{ type: 'file', path }` or `{ type: 'stdout' }`                                                                                                                                                                                         |
| `completionSignal`         | string \| string[] | `<promise>COMPLETE</promise>` | String or array of strings the agent emits to stop the iteration loop early                                                                                                                                                              |
| `idleTimeoutSeconds`       | number             | `600`                         | Idle timeout in seconds — resets on each agent output event                                                                                                                                                                              |
| `completionTimeoutSeconds` | number             | `60`                          | Grace window in seconds after the completion signal is observed but the agent process has not exited (hanging process). See [Hanging processes after the completion signal](./prompts.md#hanging-processes-after-the-completion-signal). |
| `resumeSession`            | string             | —                             | Resume a prior session by ID for agents that support resume. Incompatible with `maxIterations > 1`. Session file must exist on host.                                                                                                     |
| `signal`                   | AbortSignal        | —                             | Cancel the run when aborted. Kills the in-flight agent subprocess and cancels lifecycle hooks; the worktree is preserved on disk. Rejects with `signal.reason`.                                                                          |
| `timeouts`                 | Timeouts           | —                             | Override default timeouts for built-in lifecycle steps: `copyToWorktreeMs` (60 000), `gitSetupMs` (10 000), `commitCollectionMs` (30 000), `mergeToHostMs` (30 000).                                                                     |
| `output`                   | OutputDefinition   | —                             | Structured output definition (`Output.object(…)` or `Output.string(…)`). Requires `maxIterations === 1`. See [Structured output](./prompts.md#structured-output).                                                                        |

## `RunResult`

| Field              | Type                | Description                                                        |
| ------------------ | ------------------- | ------------------------------------------------------------------ |
| `iterations`       | `IterationResult[]` | Per-iteration results (use `.length` for the count)                |
| `completionSignal` | string?             | The matched completion signal string, or `undefined` if none fired |
| `stdout`           | string              | Agent output                                                       |
| `commits`          | `{ sha }[]`         | Commits created during the run                                     |
| `branch`           | string              | Target branch name                                                 |
| `logFilePath`      | string?             | Path to the log file (only when logging to a file)                 |
| `output`           | T?                  | Typed structured output (only present when `output` option is set) |

## `IterationResult`

| Field             | Type              | Description                                                                                                                         |
| ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`       | string?           | Agent session ID from the provider stream, or `undefined` if the provider does not emit one                                         |
| `sessionFilePath` | string?           | Absolute host path to the captured session JSONL, or `undefined` when capture is off                                                |
| `usage`           | `IterationUsage`? | Token usage snapshot from the last assistant message, or `undefined` when capture is off or provider does not support usage parsing |

## `IterationUsage`

| Field                      | Type   | Description                                |
| -------------------------- | ------ | ------------------------------------------ |
| `inputTokens`              | number | Input tokens consumed                      |
| `cacheCreationInputTokens` | number | Tokens used to create prompt cache entries |
| `cacheReadInputTokens`     | number | Tokens read from prompt cache              |
| `outputTokens`             | number | Output tokens generated                    |

## Session capture

After each resumable provider iteration, Sandcastle automatically captures the agent's session file from the sandbox to the host. Claude Code sessions are stored under `~/.claude/projects/<encoded-path>/<session-id>.jsonl`; Codex sessions are stored under `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl`; Pi sessions are stored under `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl`. Any provider-specific `cwd` fields are rewritten to match the host repo root, so the provider's native resume command works.

For Claude Code, any `Agent`-tool or `Workflow`-tool subagent transcripts written under `<session-id>/subagents/agent-*.jsonl` are captured alongside the main session. Subagent capture is best-effort: a failure on an individual transcript logs a warning and lets siblings and the main session through. Main-session capture failure still fails the run (see below).

Session capture is enabled by default for `claudeCode()`, `codex()`, and `pi()` and can be opted out via `captureSessions: false`. Providers without `sessionStorage` do not attempt capture. Capture failure fails the run.

## Session resume

Pass `resumeSession` to `run()` to continue a prior Claude Code, Codex, or Pi conversation inside a new sandbox:

```typescript
const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "Continue where you left off",
  resumeSession: "abc-123-def",
});
```

You can also continue the last captured session from a result:

```typescript
const first = await run({
  agent: codex("gpt-5.4"),
  sandbox: docker(),
  prompt: "Draft a plan",
});

const second = await first.resume?.("Now implement the plan");
```

`resume` is present only on results from resumable providers (Claude Code, Codex, Pi) — hence the optional-chaining call.

Before the sandbox starts, Sandcastle validates that the session file exists on the host and transfers it into the sandbox with `cwd` fields rewritten to match the sandbox-side path. Claude Code receives `--resume <id>`; Codex receives `codex exec resume <id>` with the prompt piped over stdin; Pi receives `--session <id>`.

Constraints:

- `resumeSession` is incompatible with `maxIterations > 1` (throws before sandbox creation).
- The provider's host session file must exist (throws before sandbox creation).
- Only iteration 1 receives the resume flag; subsequent iterations (if any) start fresh.
- Providers without resume support reject `resumeSession`.

## Session fork

`RunResult.fork(prompt, options?)` is the sibling of `.resume()`: it continues from the last captured session but leaves the parent session JSONL untouched and writes the child under a new session id. The mechanism is the agent's native fork flag — `claude --resume <id> --fork-session` for Claude Code, `codex exec fork <id>` for Codex.

Fork enables fan-out workflows where a single parent run is the starting point for several independent children:

```typescript
const parent = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "Read the codebase and summarise the data model",
});

const [reviewA, reviewB] = await Promise.all([
  parent.fork?.("Review the migration plan", {
    branchStrategy: { type: "branch", branch: "review-a" },
  }),
  parent.fork?.("Audit the auth layer", {
    branchStrategy: { type: "branch", branch: "review-b" },
  }),
]);
```

**Fork is session-only.** `--fork-session` and `codex exec fork` isolate the agent session JSONL — they do **not** isolate the branch, worktree, or sandbox. Safe concurrent fan-out (`Promise.all([r.fork(a), r.fork(b)])`) requires the caller to give each child a distinct `branch` via `branchStrategy: { type: "branch", branch: "..." }`. The default `head` and `merge-to-head` strategies are **not** safe for concurrent forks: `head` shares the host working directory across all children, and `merge-to-head` races `git merge` against the same HEAD. See [ADR 0018](../adr/0018-fork-is-session-only.md).

`fork` is present only on results from providers with `sessionStorage` (Claude Code, Codex) — hence the optional-chaining call. The same single-iteration and session-file constraints as `.resume()` apply.

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

Environment variables are also resolved automatically from `.sandcastle/.env` and `process.env` — no need to pass them to the API. The required variables depend on the **agent provider** (see `sandcastle init` output for details).
