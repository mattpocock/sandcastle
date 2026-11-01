# API

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

| Property / Method       | Type                                                                     | Description                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branch`                | string                                                                   | The branch the sandbox is on                                                                                                                                                                                                                                               |
| `worktreePath`          | string                                                                   | Host path to the worktree                                                                                                                                                                                                                                                  |
| `sandboxId`             | string \| undefined                                                      | The provider's id for the sandbox, so a supervisor outside the process can address it: the container name for `docker()`/`podman()` (`docker rm -f <sandboxId>`), the sandbox id for `vercel()` and `daytona()`. `undefined` for `noSandbox()`, `bwrap()` and `seatbelt()` |
| `run(options)`          | `(SandboxRunOptions) => Promise<SandboxRunResult>`                       | Invoke an agent inside the existing sandbox                                                                                                                                                                                                                                |
| `interactive(options)`  | `(SandboxInteractiveOptions) => Promise<SandboxInteractiveResult>`       | Launch an interactive session in the sandbox                                                                                                                                                                                                                               |
| `exec(cmd, options?)`   | `(command: string, options?: SandboxExecOptions) => Promise<ExecResult>` | Run a shell command in the sandbox. `cwd` defaults to the sandbox repo path. Non-zero `exitCode` is returned, not thrown.                                                                                                                                                  |
| `close()`               | `() => Promise<CloseResult>`                                             | Tear down the container and sandbox                                                                                                                                                                                                                                        |
| `[Symbol.asyncDispose]` | `() => Promise<void>`                                                    | Auto teardown via `await using`                                                                                                                                                                                                                                            |

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

## `createWorktree()` — independent worktree lifecycle

Use `createWorktree()` when you need a worktree (git worktree) as an independent, first-class concept — separate from any sandbox. This is useful when you want to run an interactive session first and then hand the same worktree to a sandboxed AFK agent.

Only `branch` and `merge-to-head` strategies are accepted; `head` is a compile-time type error since it means no worktree.

Pass `cwd` to target a repo other than `process.cwd()`. Relative paths resolve against `process.cwd()`; absolute paths pass through. A `CwdError` is thrown if the path does not exist or is not a directory.

```typescript
import { createWorktree } from "@ai-hero/sandcastle";

await using wt = await createWorktree({
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  copyToWorktree: ["node_modules"],
  cwd: "/path/to/other-repo", // optional — defaults to process.cwd()
});

console.log(wt.worktreePath); // host path to the worktree
console.log(wt.branch); // "agent/fix-42"

// Run an interactive session in the worktree (defaults to noSandbox)
await wt.interactive({
  agent: claudeCode("claude-opus-4-8"),
  prompt: "Explore the codebase and understand the bug.",
});

// Run an AFK agent in the worktree (sandbox is required)
const result = await wt.run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker({ imageName: "sandcastle:myrepo" }),
  prompt: "Fix issue #42.",
  maxIterations: 3,
});
console.log(result.commits); // commits made during the run

// Create a long-lived sandbox from the worktree
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await using sandbox = await wt.createSandbox({
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

// sandbox.close() tears down the container only — the worktree stays
await sandbox.close();

// wt.close() cleans up the worktree
```

`wt.close()` checks for uncommitted changes: if the worktree is dirty, it's preserved on disk; if clean, it's removed. `await using` calls `close()` automatically. The worktree persists after `run()`, `interactive()`, and `createSandbox()` complete, so you can hand it to another agent or inspect it.

With `branchStrategy: { type: "merge-to-head" }`, each `wt.run()` / `wt.interactive()` merges the agent's commits back to the host's current branch before returning, and the worktree's source branch is preserved across calls so subsequent ones can reuse the same handle. (This differs from top-level `run()`, where the temp branch is deleted after the merge.) `wt.close()` deletes it, unless it holds commits that are on no other branch (for example after a failed merge), in which case it is kept.

**Split ownership**: When a sandbox is created via `wt.createSandbox()`, `sandbox.close()` tears down the container only — the worktree remains. `wt.close()` is responsible for worktree cleanup. This differs from the top-level `createSandbox()`, where `sandbox.close()` owns both container and worktree.

### `CreateWorktreeOptions`

| Option           | Type                   | Default | Description                                                                                                         |
| ---------------- | ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `branchStrategy` | WorktreeBranchStrategy | —       | **Required.** `{ type: "branch", branch }` or `{ type: "merge-to-head" }`                                           |
| `copyToWorktree` | string[]               | —       | Host-relative file paths to copy into the worktree at creation time                                                 |
| `timeouts`       | Timeouts               | —       | Override built-in lifecycle step timeouts (`copyToWorktreeMs`, `gitSetupMs`, `commitCollectionMs`, `mergeToHostMs`) |

### `Worktree`

| Property / Method        | Type                                                                  | Description                                         |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------------------- |
| `branch`                 | string                                                                | The branch the worktree is on                       |
| `worktreePath`           | string                                                                | Host path to the worktree                           |
| `run(options)`           | `(options: WorktreeRunOptions) => Promise<WorktreeRunResult>`         | Run an AFK agent in the worktree (sandbox required) |
| `interactive(options)`   | `(options: WorktreeInteractiveOptions) => Promise<InteractiveResult>` | Run an interactive agent session in the worktree    |
| `createSandbox(options)` | `(options: WorktreeCreateSandboxOptions) => Promise<Sandbox>`         | Create a long-lived sandbox backed by this worktree |
| `close()`                | `() => Promise<CloseResult>`                                          | Clean up the worktree (preserves if dirty)          |
| `[Symbol.asyncDispose]`  | `() => Promise<void>`                                                 | Auto cleanup via `await using`                      |

### `WorktreeInteractiveOptions`

| Option       | Type                   | Default       | Description                                                                                       |
| ------------ | ---------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `agent`      | AgentProvider          | —             | **Required.** Agent provider                                                                      |
| `sandbox`    | AnySandboxProvider     | `noSandbox()` | Sandbox provider (defaults to no sandbox)                                                         |
| `prompt`     | string                 | —             | Inline prompt (mutually exclusive with `promptFile`)                                              |
| `promptFile` | string                 | —             | Path to prompt file                                                                               |
| `name`       | string                 | —             | Optional session name                                                                             |
| `hooks`      | SandboxHooks           | —             | Lifecycle hooks (`host.*`, `sandbox.*`)                                                           |
| `promptArgs` | PromptArgs             | —             | Key-value map for `{{KEY}}` placeholder substitution                                              |
| `env`        | Record<string, string> | —             | Environment variables to inject into the sandbox                                                  |
| `signal`     | AbortSignal            | —             | Cancel the session when aborted. The worktree is preserved on disk. Rejects with `signal.reason`. |

### `WorktreeRunOptions`

| Option                     | Type                   | Default | Description                                                                                                                          |
| -------------------------- | ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                    | AgentProvider          | —       | **Required.** Agent provider                                                                                                         |
| `sandbox`                  | SandboxProvider        | —       | **Required.** Sandbox provider (AFK agents must be sandboxed)                                                                        |
| `prompt`                   | string                 | —       | Inline prompt (mutually exclusive with `promptFile`)                                                                                 |
| `promptFile`               | string                 | —       | Path to prompt file                                                                                                                  |
| `maxIterations`            | number                 | 1       | Maximum iterations to run                                                                                                            |
| `completionSignal`         | string \| string[]     | —       | Substring(s) to stop the iteration loop early                                                                                        |
| `idleTimeoutSeconds`       | number                 | 600     | Idle timeout in seconds                                                                                                              |
| `completionTimeoutSeconds` | number                 | 60      | Grace window after completion signal is seen but agent process hasn't exited                                                         |
| `name`                     | string                 | —       | Optional run name                                                                                                                    |
| `logging`                  | LoggingOption          | file    | Logging mode                                                                                                                         |
| `hooks`                    | SandboxHooks           | —       | Lifecycle hooks (`host.*`, `sandbox.*`)                                                                                              |
| `promptArgs`               | PromptArgs             | —       | Key-value map for `{{KEY}}` placeholder substitution                                                                                 |
| `env`                      | Record<string, string> | —       | Environment variables to inject into the sandbox                                                                                     |
| `resumeSession`            | string                 | —       | Resume a prior session by ID for agents that support resume. Incompatible with `maxIterations > 1`. Session file must exist on host. |
| `signal`                   | AbortSignal            | —       | Cancel the run when aborted. Kills the in-flight agent subprocess; the worktree is preserved on disk. Rejects with `signal.reason`.  |

### `WorktreeRunResult`

| Property           | Type                | Description                                            |
| ------------------ | ------------------- | ------------------------------------------------------ |
| `iterations`       | `IterationResult[]` | Per-iteration results (use `.length` for the count)    |
| `completionSignal` | string              | The matched completion signal, or undefined            |
| `stdout`           | string              | Combined stdout output from all agent iterations       |
| `commits`          | { sha: string }[]   | List of commits made by the agent during the run       |
| `branch`           | string              | The branch name the agent worked on                    |
| `logFilePath`      | string              | Path to the log file, if logging was drained to a file |

### `WorktreeCreateSandboxOptions`

| Option           | Type            | Default | Description                                                                                                         |
| ---------------- | --------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `sandbox`        | SandboxProvider | —       | **Required.** Sandbox provider (e.g. `docker()`)                                                                    |
| `hooks`          | SandboxHooks    | —       | Lifecycle hooks (`host.*`, `sandbox.*`)                                                                             |
| `copyToWorktree` | string[]        | —       | Host-relative file paths to copy into the worktree at creation time                                                 |
| `timeouts`       | Timeouts        | —       | Override built-in lifecycle step timeouts (`copyToWorktreeMs`, `gitSetupMs`, `commitCollectionMs`, `mergeToHostMs`) |
