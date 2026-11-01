# `run()` and `createSandbox()`

Sandcastle exports a programmatic `run()` function for use in scripts, CI pipelines, or custom tooling. The examples below use `docker()`, but any `SandboxProvider` works in its place.

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
});

console.log(result.iterations.length); // number of iterations executed
console.log(result.iterations); // per-iteration results with optional sessionId
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

Every option and result field below links to the page for its term.

## `RunOptions`

| Option                     | Type               | Default                       | Description                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                    | AgentProvider      | —                             | **Required.** Agent provider (e.g. `claudeCode("claude-opus-4-8")`, `pi("claude-sonnet-4-6")`, `codex("gpt-5.4")`, `cursor("composer-2")`, `opencode("opencode/big-pickle")`, `copilot("claude-sonnet-4.5")`). See [Agent providers](./agent-providers.md). |
| `sandbox`                  | SandboxProvider    | —                             | **Required.** Sandbox provider (e.g. `docker()`, `podman()`, `docker({ imageName: "sandcastle:local" })`). See [Sandbox providers](./sandbox-providers.md).                                                                                                 |
| `cwd`                      | string             | `process.cwd()`               | Host repo directory — anchor for `.sandcastle/` artifacts and git operations. Relative paths resolve against `process.cwd()`. See [Core concepts](./core-concepts.md).                                                                                      |
| `prompt`                   | string             | —                             | Inline prompt (mutually exclusive with `promptFile`). See [Prompts](./prompts.md).                                                                                                                                                                          |
| `promptFile`               | string             | —                             | Path to prompt file (mutually exclusive with `prompt`). Resolves against `process.cwd()`, **not** `cwd`. See [Prompts](./prompts.md).                                                                                                                       |
| `maxIterations`            | number             | `1`                           | Maximum iterations to run. See [Iterations](./iterations.md).                                                                                                                                                                                               |
| `hooks`                    | SandboxHooks       | —                             | Lifecycle hooks (`host.*`, `sandbox.*`). See [Hooks](./hooks.md).                                                                                                                                                                                           |
| `name`                     | string             | —                             | Display name for the run, shown as a prefix in log output. See [Run logs](./run-logs.md).                                                                                                                                                                   |
| `promptArgs`               | PromptArgs         | —                             | Key-value map for `{{KEY}}` placeholder substitution. See [Prompts](./prompts.md).                                                                                                                                                                          |
| `branchStrategy`           | BranchStrategy     | per-provider default          | Branch strategy: `{ type: 'head' }`, `{ type: 'merge-to-head' }`, or `{ type: 'branch', branch: '…' }`. See [Branch strategies](./branch-strategies.md).                                                                                                    |
| `copyToWorktree`           | string[]           | —                             | Host-relative file paths to copy into the sandbox before start (not supported with `branchStrategy: { type: 'head' }`). See [Branch strategies](./branch-strategies.md).                                                                                    |
| `logging`                  | object             | file (auto-generated)         | `{ type: 'file', path }` or `{ type: 'stdout' }`. See [Run logs](./run-logs.md).                                                                                                                                                                            |
| `completionSignal`         | string \| string[] | `<promise>COMPLETE</promise>` | String or array of strings the agent emits to stop the iteration loop early. See [Iterations](./iterations.md).                                                                                                                                             |
| `idleTimeoutSeconds`       | number             | `600`                         | Idle timeout in seconds — resets on each agent output event. See [Iterations](./iterations.md).                                                                                                                                                             |
| `completionTimeoutSeconds` | number             | `60`                          | Grace window in seconds after the completion signal is observed but the agent process has not exited (hanging process). See [Hanging processes after the completion signal](./iterations.md#hanging-processes-after-the-completion-signal).                 |
| `resumeSession`            | string             | —                             | Resume a prior session by ID for agents that support resume. Incompatible with `maxIterations > 1`. Session file must exist on host. See [Agent sessions](./agent-sessions.md).                                                                             |
| `signal`                   | AbortSignal        | —                             | Cancel the run when aborted. Kills the in-flight agent subprocess and cancels lifecycle hooks; the worktree is preserved on disk. Rejects with `signal.reason`.                                                                                             |
| `timeouts`                 | Timeouts           | —                             | Override default timeouts for built-in lifecycle steps: `copyToWorktreeMs` (60 000), `gitSetupMs` (10 000), `commitCollectionMs` (30 000), `mergeToHostMs` (30 000). See [Branch strategies](./branch-strategies.md).                                       |
| `output`                   | OutputDefinition   | —                             | Structured output definition (`Output.object(…)` or `Output.string(…)`). Requires `maxIterations === 1`. See [Structured output](./structured-output.md).                                                                                                   |

## All options

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const result = await run({
  // Agent provider — required. Pass a model string to claudeCode().
  // Optional second arg for provider-specific options like effort level.
  agent: claudeCode("claude-opus-4-8", { effort: "high" }),

  // Sandbox provider — required. Any SandboxProvider works (docker, podman, vercel, or custom).
  // Provider-specific config (like imageName, mounts) lives inside the provider factory call.
  sandbox: docker({
    imageName: "sandcastle:local",
    // Optional: override the UID/GID used for --user flag (defaults to host UID/GID).
    // Must match the UID baked into the image. Pre-flight check catches mismatches.
    // containerUid: 1000,
    // containerGid: 1000,
    // Optional: mount host directories into the sandbox (e.g. package manager caches)
    // hostPath supports absolute, tilde-expanded (~), and relative paths (resolved from cwd).
    // sandboxPath supports absolute and relative paths (resolved from the sandbox repo directory).
    mounts: [
      { hostPath: "~/.npm", sandboxPath: "/home/agent/.npm", readonly: true },
      { hostPath: "data", sandboxPath: "data" }, // mounts <cwd>/data → <sandbox-repo>/data
    ],
    // Optional: SELinux volume label — "z" (default, shared), "Z" (private), or false (none).
    // No-op on non-SELinux systems (Docker Desktop on macOS/Windows, Linux without SELinux).
    selinuxLabel: "z",
    // Optional: provider-level env vars merged at launch time
    env: { DOCKER_SPECIFIC: "value" },
    // Optional: attach container to Docker network(s) — string or string[]
    network: "my-network",
    // Optional: add the container user to supplementary groups via --group-add.
    // Accepts group names or numeric GIDs (e.g. for a bind-mounted Docker socket).
    groups: ["docker", 999],
    // Optional: expose host devices via --device. Each entry is a full device
    // spec in host[:container[:permissions]] form (e.g. "/dev/kvm").
    devices: ["/dev/kvm"],
    // Optional: drop Linux capabilities via --cap-drop (podman() takes the same).
    // Names omit the CAP_ prefix; "ALL" drops every one. Typos are type errors.
    capDrop: ["NET_RAW"],
    // Optional: limit CPU resources via --cpus. Fractional values allowed (e.g. 1.5).
    // cpus: 2,
  }),

  // Host repo directory — replaces process.cwd() as the anchor for
  // .sandcastle/ artifacts (worktrees, logs, env, patches) and git operations.
  // Relative paths resolve against process.cwd(). Defaults to process.cwd().
  cwd: "../other-repo",

  // Branch strategy — controls how the agent's changes relate to branches.
  // Defaults to { type: "head" } for bind-mount and { type: "merge-to-head" } for isolated providers.
  branchStrategy: { type: "branch", branch: "agent/fix-42" },

  // Prompt source — provide one of these, not both.
  // Note: promptFile resolves against process.cwd(), NOT cwd.
  promptFile: ".sandcastle/prompt.md", // path to a prompt file
  // prompt: "Fix issue #42 in this repo", // OR an inline prompt string

  // Values substituted for {{KEY}} placeholders in the prompt.
  promptArgs: {
    ISSUE_NUMBER: "42",
  },

  // Maximum number of agent iterations to run before stopping. Default: 1
  maxIterations: 5,

  // Display name for this run, shown as a prefix in log output.
  name: "fix-issue-42",

  // Lifecycle hooks grouped by where they run: host or sandbox.
  hooks: {
    host: {
      onWorktreeReady: [{ command: "cp .env.example .env" }],
      onSandboxReady: [{ command: "echo setup done" }],
    },
    sandbox: {
      onSandboxReady: [{ command: "npm install" }],
    },
  },

  // Host-relative file paths to copy into the sandbox before the container starts.
  // Not supported with branchStrategy: { type: "head" }.
  copyToWorktree: [".env"],

  // Override default timeouts for built-in lifecycle steps.
  // Unset keys keep their defaults.
  timeouts: {
    copyToWorktreeMs: 120_000, // default: 60_000
    gitSetupMs: 30_000, // default: 10_000
    commitCollectionMs: 60_000, // default: 30_000
    mergeToHostMs: 60_000, // default: 30_000
  },

  // How to record progress. Default: write to a file under .sandcastle/logs/
  logging: {
    type: "file",
    path: ".sandcastle/logs/my-run.log",
    // Optional: forward the agent's output stream to your own observability system.
    // Fires for each text chunk, tool call, and raw stdout line the agent
    // produces. Errors thrown by the callback are swallowed so a broken
    // forwarder cannot kill the run.
    onAgentStreamEvent: (event) => {
      // event is { type: "text" | "toolCall" | "raw", iteration, timestamp, ... }
      myLogger.info(event);
    },
    // Optional: append every raw stdout line the agent emits to the same
    // log file, interleaved with the human-readable output. Includes lines
    // the provider's stream parser would otherwise drop. Intended for
    // debugging stuck or unexpected agent behaviour.
    verbose: true,
  },
  // logging: { type: "stdout", verbose: true }, // OR terminal mode (verbose: raw lines to stdout)

  // String (or array of strings) the agent emits to end the iteration loop early.
  // Default: "<promise>COMPLETE</promise>"
  completionSignal: "<promise>COMPLETE</promise>",

  // Idle timeout in seconds — resets whenever the agent produces output. Default: 600 (10 minutes)
  idleTimeoutSeconds: 600,

  // Grace window in seconds after the agent emits a completion signal but
  // before its process has exited (a "hanging process" — typically a spawned
  // `gh`/git child or MCP server keeping stdout open). Resets on every
  // subsequent output line so trailing data is still captured. Default: 60
  completionTimeoutSeconds: 60,

  // Structured output — extract a typed payload from the agent's stdout.
  // Requires maxIterations === 1 and the tag must appear in the prompt.
  // output: Output.object({ tag: "result", schema: z.object({ answer: z.number() }) }),
  // output: Output.string({ tag: "summary" }),
});

console.log(result.iterations.length); // number of iterations executed
console.log(result.completionSignal); // matched signal string, or undefined if none fired
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

## `RunResult`

| Field                   | Type                                        | Description                                                                                                                                                |
| ----------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iterations`            | `IterationResult[]`                         | Per-iteration results (use `.length` for the count). See [Iterations](./iterations.md).                                                                    |
| `completionSignal`      | string?                                     | The matched completion signal string, or `undefined` if none fired. See [Iterations](./iterations.md).                                                     |
| `stdout`                | string                                      | Agent output                                                                                                                                               |
| `commits`               | `{ sha }[]`                                 | Commits created during the run. See [Branch strategies](./branch-strategies.md).                                                                           |
| `branch`                | string                                      | Target branch name. See [Branch strategies](./branch-strategies.md).                                                                                       |
| `logFilePath`           | string?                                     | Path to the log file (only when logging to a file). See [Run logs](./run-logs.md).                                                                         |
| `output`                | T?                                          | Typed structured output (only present when `output` option is set). See [Structured output](./structured-output.md).                                       |
| `preservedWorktreePath` | string?                                     | Host path to the preserved worktree, set when the run succeeded but the worktree had uncommitted changes. See [Branch strategies](./branch-strategies.md). |
| `resume`                | `(prompt, options?) => Promise<RunResult>`? | Continue the last captured agent session for one iteration. See [Session resume](./agent-sessions.md#session-resume).                                      |
| `fork`                  | `(prompt, options?) => Promise<RunResult>`? | Fork the last captured agent session for one iteration. See [Session fork](./agent-sessions.md#session-fork).                                              |

## `IterationResult`

| Field             | Type              | Description                                                                                                                                                                        |
| ----------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`       | string?           | Agent session ID from the provider stream, or `undefined` if the provider does not emit one                                                                                        |
| `sessionFilePath` | string?           | Absolute host path to the captured session JSONL, or `undefined` when capture is off                                                                                               |
| `usage`           | `IterationUsage`? | Token usage snapshot from the last assistant message, or `undefined` when capture is off or provider does not support usage parsing                                                |
| `contextWindow`   | `ContextWindow`?  | Input tokens of the iteration's last model call, cache included (shown as `Context window: NNNk` after the run), or `undefined` when the agent reports no per-call figure (cursor) |

## `ContextWindow`

| Field    | Type    | Description                                                                           |
| -------- | ------- | ------------------------------------------------------------------------------------- |
| `tokens` | number  | Input tokens of the last model call, cached and uncached together. Never a turn total |
| `limit`  | number? | The model's context window size, only when the agent reports it (codex)               |

Sources: claudeCode, pi, opencode and copilot read it from the agent's stream, so it works on every sandbox. codex reads it from its captured session, so it needs a bind-mount sandbox (docker, podman) with `captureSessions` on. cursor reports only a whole-turn total, so it has none.

## `IterationUsage`

| Field                      | Type   | Description                                |
| -------------------------- | ------ | ------------------------------------------ |
| `inputTokens`              | number | Input tokens consumed                      |
| `cacheCreationInputTokens` | number | Tokens used to create prompt cache entries |
| `cacheReadInputTokens`     | number | Tokens read from prompt cache              |
| `outputTokens`             | number | Output tokens generated                    |

## `createSandbox()` — reusable sandbox

Use `createSandbox()` when you need to run multiple agents (or multiple rounds of the same agent) inside a single sandbox. It creates the sandbox once, and you call `sandbox.run()` as many times as you need. This avoids repeated container startup costs and keeps all runs on the same branch.

Use `run()` instead when you only need a single one-shot invocation — it handles sandbox lifecycle automatically.

### Basic single-run usage

```typescript
import { createSandbox, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
});

const result = await sandbox.run({
  agent: claudeCode("claude-opus-4-8"),
  prompt: "Fix issue #42 in this repo.",
});

console.log(result.commits); // [{ sha: "abc123" }]
```

### Multi-run implement-then-review

```typescript
import { createSandbox, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

// Step 1: implement
const implResult = await sandbox.run({
  agent: claudeCode("claude-opus-4-8"),
  promptFile: ".sandcastle/implement.md",
  maxIterations: 5,
});

// Step 2: review on the same branch, same container
const reviewResult = await sandbox.run({
  agent: claudeCode("claude-sonnet-4-6"),
  prompt: "Review the changes and fix any issues.",
});
```

Commits from all `run()` calls accumulate on the same branch. The sandbox container stays alive between runs, so installed dependencies and build artifacts persist.

`sandbox.exec()` lets the harness run shell commands directly in the same warm sandbox — handy for gating an implement step on a quick verification before kicking off the review:

```typescript
await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

await sandbox.run({
  agent: claudeCode("claude-opus-4-8"),
  promptFile: ".sandcastle/implement.md",
  maxIterations: 5,
});

// Verify before review — non-zero exitCode is returned, not thrown.
const tests = await sandbox.exec("npm test");
if (tests.exitCode !== 0) {
  throw new Error(`Tests failed:\n${tests.stdout}\n${tests.stderr}`);
}

await sandbox.run({
  agent: claudeCode("claude-sonnet-4-6"),
  prompt: "Review the changes and fix any issues.",
});
```

`cwd` defaults to the sandbox repo path, matching `interactive()`. Pass `cwd` to override.

### Automatic cleanup with `await using`

`await using` calls `sandbox.close()` automatically when the block exits. If the sandbox has uncommitted changes, the worktree is preserved on disk; if clean, both container and worktree are removed.

### Manual `close()` with `CloseResult`

```typescript
const sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
});
// ... run agents ...
const closeResult = await sandbox.close();
if (closeResult.preservedWorktreePath) {
  console.log(`Worktree preserved at ${closeResult.preservedWorktreePath}`);
}
```

### `CreateSandboxOptions`

| Option           | Type            | Default         | Description                                                                                                         |
| ---------------- | --------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `branch`         | string          | —               | **Required.** Explicit branch for the sandbox                                                                       |
| `sandbox`        | SandboxProvider | —               | **Required.** Sandbox provider (e.g. `docker()`, `podman()`)                                                        |
| `cwd`            | string          | `process.cwd()` | Host repo directory — relative paths resolve against `process.cwd()`                                                |
| `hooks`          | SandboxHooks    | —               | Lifecycle hooks (`host.*`, `sandbox.*`) — run once at creation time                                                 |
| `copyToWorktree` | string[]        | —               | Host-relative file paths to copy into the sandbox at creation time                                                  |
| `timeouts`       | Timeouts        | —               | Override built-in lifecycle step timeouts (`copyToWorktreeMs`, `gitSetupMs`, `commitCollectionMs`, `mergeToHostMs`) |

### `Sandbox`

| Property / Method       | Type                                                                     | Description                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `branch`                | string                                                                   | The branch the sandbox is on                                                                                              |
| `worktreePath`          | string                                                                   | Host path to the worktree                                                                                                 |
| `run(options)`          | `(SandboxRunOptions) => Promise<SandboxRunResult>`                       | Invoke an agent inside the existing sandbox                                                                               |
| `interactive(options)`  | `(SandboxInteractiveOptions) => Promise<SandboxInteractiveResult>`       | Launch an interactive session in the sandbox                                                                              |
| `exec(cmd, options?)`   | `(command: string, options?: SandboxExecOptions) => Promise<ExecResult>` | Run a shell command in the sandbox. `cwd` defaults to the sandbox repo path. Non-zero `exitCode` is returned, not thrown. |
| `close()`               | `() => Promise<CloseResult>`                                             | Tear down the container and sandbox                                                                                       |
| `[Symbol.asyncDispose]` | `() => Promise<void>`                                                    | Auto teardown via `await using`                                                                                           |

### `SandboxRunOptions`

| Option                     | Type               | Default                       | Description                                                                                                                          |
| -------------------------- | ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                    | AgentProvider      | —                             | **Required.** Agent provider (e.g. `claudeCode("claude-opus-4-8")`)                                                                  |
| `prompt`                   | string             | —                             | Inline prompt (mutually exclusive with `promptFile`)                                                                                 |
| `promptFile`               | string             | —                             | Path to prompt file (mutually exclusive with `prompt`)                                                                               |
| `promptArgs`               | PromptArgs         | —                             | Key-value map for `{{KEY}}` placeholder substitution                                                                                 |
| `maxIterations`            | number             | `1`                           | Maximum iterations to run                                                                                                            |
| `completionSignal`         | string \| string[] | `<promise>COMPLETE</promise>` | String(s) the agent emits to stop the iteration loop early                                                                           |
| `idleTimeoutSeconds`       | number             | `600`                         | Idle timeout in seconds — resets on each agent output event                                                                          |
| `completionTimeoutSeconds` | number             | `60`                          | Grace window after the completion signal is seen but the agent process hasn't exited                                                 |
| `name`                     | string             | —                             | Display name for the run                                                                                                             |
| `logging`                  | object             | file (auto-generated)         | `{ type: 'file', path }` or `{ type: 'stdout' }`                                                                                     |
| `resumeSession`            | string             | —                             | Resume a prior session by ID for agents that support resume. Incompatible with `maxIterations > 1`. Session file must exist on host. |
| `signal`                   | AbortSignal        | —                             | Cancels the run when aborted; handle stays usable afterward                                                                          |

### `SandboxRunResult`

| Field                      | Type                                                                                     | Description                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `iterations`               | `IterationResult[]`                                                                      | Per-iteration results (use `.length` for the count)                                                                                 |
| `completionSignal`         | string?                                                                                  | The matched completion signal string, or `undefined` if none fired                                                                  |
| `stdout`                   | string                                                                                   | Combined agent output from all iterations                                                                                           |
| `commits`                  | `{ sha }[]`                                                                              | Commits created during the run                                                                                                      |
| `logFilePath`              | string?                                                                                  | Path to the log file (only when logging to a file)                                                                                  |
| `resume(prompt, options?)` | `(prompt: string, options?: ResumeSandboxRunResultOptions) => Promise<SandboxRunResult>` | Continue the captured session for one iteration inside the same warm sandbox. Present only when the provider captured a session id. |
| `fork(prompt, options?)`   | `(prompt: string, options?: ResumeSandboxRunResultOptions) => Promise<SandboxRunResult>` | Fork the captured session for one iteration inside the same warm sandbox. The parent session is left intact (ADR 0018).             |

### `CloseResult`

| Field                   | Type    | Description                                                              |
| ----------------------- | ------- | ------------------------------------------------------------------------ |
| `preservedWorktreePath` | string? | Host path to the preserved worktree, set when it had uncommitted changes |
