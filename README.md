<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-ondark_2x.png">
    <source media="(prefers-color-scheme: light)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png">
    <img alt="Sandcastle" src="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png" height="200" style="margin-bottom: 20px;">
  </picture>
</div>

## What Is Sandcastle?

A TypeScript library for orchestrating AI coding agents in isolated Docker containers:

1. You invoke agents with a single `sandcastle.run()`.
2. Sandcastle handles sandboxing the agent with a configurable branch strategy.
3. The commits made on the branches get merged back.

Great for parallelizing multiple AFK agents, creating review pipelines, or even just orchestrating your own agents.

## Prerequisites

- [Docker Desktop](https://www.docker.com/)
- [Git](https://git-scm.com/)

## Quick start

1. Install the package:

```bash
npm install @ai-hero/sandcastle
```

2. Run `sandcastle init`. This scaffolds a `.sandcastle` directory with all the files needed.

```bash
npx sandcastle init
```

3. Edit `.sandcastle/.env` and fill in your default values for `ANTHROPIC_API_KEY`. If you want to use your Claude subscription instead of an API key, see [#191](https://github.com/mattpocock/sandcastle/issues/191).

```bash
cp .sandcastle/.env.example .sandcastle/.env
```

4. Run the `.sandcastle/main.ts` (or `main.mts`) file with `npx tsx`

```bash
npx tsx .sandcastle/main.ts
```

```typescript
// 3. Run the agent via the JS API
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
});
```

## API

Sandcastle exports a programmatic `run()` function for use in scripts, CI pipelines, or custom tooling.

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
});

console.log(result.iterationsRun); // number of iterations executed
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

### All options

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const result = await run({
  // Agent provider — required. Pass a model string to claudeCode().
  // Optional second arg for provider-specific options like effort level.
  agent: claudeCode("claude-opus-4-6", { effort: "high" }),

  // Sandbox provider — required. Import from "@ai-hero/sandcastle/sandboxes/docker".
  // Provider-specific config (like imageName and branchStrategy) lives inside the provider factory call.
  sandbox: docker({
    imageName: "sandcastle:local",
    branchStrategy: { type: "branch", branch: "agent/fix-42" },
  }),

  // Prompt source — provide one of these, not both:
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

  // Lifecycle hooks — arrays of shell commands run sequentially inside the sandbox.
  hooks: {
    // Runs after the sandbox is ready.
    onSandboxReady: [{ command: "npm install" }],
  },

  // Host-relative file paths to copy into the sandbox before the container starts.
  // Not supported with branchStrategy: { type: "head" }.
  copyToSandbox: [".env"],

  // How to record progress. Default: write to a file under .sandcastle/logs/
  logging: { type: "file", path: ".sandcastle/logs/my-run.log" },
  // logging: { type: "stdout" }, // OR render an interactive UI in the terminal

  // String (or array of strings) the agent emits to end the iteration loop early.
  // Default: "<promise>COMPLETE</promise>"
  completionSignal: "<promise>COMPLETE</promise>",

  // Idle timeout in seconds — resets whenever the agent produces output. Default: 600 (10 minutes)
  idleTimeoutSeconds: 600,
});

console.log(result.iterationsRun); // number of iterations executed
console.log(result.completionSignal); // matched signal string, or undefined if none fired
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

### `createSandbox()` — reusable sandbox

Use `createSandbox()` when you need to run multiple agents (or multiple rounds of the same agent) inside a single sandbox. It creates the sandbox once, and you call `sandbox.run()` as many times as you need. This avoids repeated container startup costs and keeps all runs on the same branch.

Use `run()` instead when you only need a single one-shot invocation — it handles sandbox lifecycle automatically.

#### Basic single-run usage

```typescript
import { createSandbox, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
});

const result = await sandbox.run({
  agent: claudeCode("claude-opus-4-6"),
  prompt: "Fix issue #42 in this repo.",
});

console.log(result.commits); // [{ sha: "abc123" }]
```

#### Multi-run implement-then-review

```typescript
import { createSandbox, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
  hooks: { onSandboxReady: [{ command: "npm install" }] },
});

// Step 1: implement
const implResult = await sandbox.run({
  agent: claudeCode("claude-opus-4-6"),
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

#### Automatic cleanup with `await using`

`await using` calls `sandbox.close()` automatically when the block exits. If the sandbox has uncommitted changes, the worktree is preserved on disk; if clean, both container and worktree are removed.

#### Manual `close()` with `CloseResult`

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

#### `CreateSandboxOptions`

| Option          | Type            | Default | Description                                                        |
| --------------- | --------------- | ------- | ------------------------------------------------------------------ |
| `branch`        | string          | —       | **Required.** Explicit branch for the sandbox                      |
| `sandbox`       | SandboxProvider | —       | **Required.** Sandbox provider (e.g. `docker()`)                   |
| `hooks`         | object          | —       | Lifecycle hooks (`onSandboxReady`) — run once at creation time     |
| `copyToSandbox` | string[]        | —       | Host-relative file paths to copy into the sandbox at creation time |

#### `Sandbox`

| Property / Method       | Type                                               | Description                                 |
| ----------------------- | -------------------------------------------------- | ------------------------------------------- |
| `branch`                | string                                             | The branch the sandbox is on                |
| `worktreePath`          | string                                             | Host path to the worktree                   |
| `run(options)`          | `(SandboxRunOptions) => Promise<SandboxRunResult>` | Invoke an agent inside the existing sandbox |
| `close()`               | `() => Promise<CloseResult>`                       | Tear down the container and sandbox         |
| `[Symbol.asyncDispose]` | `() => Promise<void>`                              | Auto teardown via `await using`             |

#### `SandboxRunOptions`

| Option               | Type               | Default                       | Description                                                         |
| -------------------- | ------------------ | ----------------------------- | ------------------------------------------------------------------- |
| `agent`              | AgentProvider      | —                             | **Required.** Agent provider (e.g. `claudeCode("claude-opus-4-6")`) |
| `prompt`             | string             | —                             | Inline prompt (mutually exclusive with `promptFile`)                |
| `promptFile`         | string             | —                             | Path to prompt file (mutually exclusive with `prompt`)              |
| `promptArgs`         | PromptArgs         | —                             | Key-value map for `{{KEY}}` placeholder substitution                |
| `maxIterations`      | number             | `1`                           | Maximum iterations to run                                           |
| `completionSignal`   | string \| string[] | `<promise>COMPLETE</promise>` | String(s) the agent emits to stop the iteration loop early          |
| `idleTimeoutSeconds` | number             | `600`                         | Idle timeout in seconds — resets on each agent output event         |
| `name`               | string             | —                             | Display name for the run                                            |
| `logging`            | object             | file (auto-generated)         | `{ type: 'file', path }` or `{ type: 'stdout' }`                    |

#### `SandboxRunResult`

| Field              | Type        | Description                                                        |
| ------------------ | ----------- | ------------------------------------------------------------------ |
| `iterationsRun`    | number      | Number of iterations executed                                      |
| `completionSignal` | string?     | The matched completion signal string, or `undefined` if none fired |
| `stdout`           | string      | Combined agent output from all iterations                          |
| `commits`          | `{ sha }[]` | Commits created during the run                                     |
| `logFilePath`      | string?     | Path to the log file (only when logging to a file)                 |

#### `CloseResult`

| Field                   | Type    | Description                                                              |
| ----------------------- | ------- | ------------------------------------------------------------------------ |
| `preservedWorktreePath` | string? | Host path to the preserved worktree, set when it had uncommitted changes |

## How it works

Sandcastle uses a **branch strategy** configured on the sandbox provider to control how the agent's changes relate to branches. There are three strategies:

- **Head** (`{ type: "head" }`) — The agent writes directly to the host working directory. No worktree, no branch indirection. This is the default for bind-mount providers like `docker()`.
- **Merge-to-head** (`{ type: "merge-to-head" }`) — Sandcastle creates a temporary branch in a git worktree. The agent works on the temp branch, and changes are merged back to HEAD when done. The temp branch is cleaned up after merge.
- **Branch** (`{ type: "branch", branch: "foo" }`) — Commits land on an explicitly named branch in a git worktree.

For bind-mount providers (like Docker), the worktree directory is bind-mounted into the container — the agent writes directly to the host filesystem through the mount, so no sync is needed.

From your point of view, you just configure `docker({ branchStrategy: { type: 'branch', branch: 'foo' } })`, and get a commit on branch `foo` once it's complete. All 100% local.

## Prompts

Sandcastle uses a flexible prompt system. You write the prompt, and the engine executes it — no opinions about workflow, task management, or context sources are imposed.

### Prompt resolution

You must provide exactly one of:

1. `prompt: "inline string"` — pass an inline prompt directly via `RunOptions`
2. `promptFile: "./path/to/prompt.md"` — point to a specific file via `RunOptions`

`prompt` and `promptFile` are mutually exclusive — providing both is an error. If neither is provided, `run()` throws an error asking you to supply one.

> **Convention**: `sandcastle init` scaffolds `.sandcastle/prompt.md` and all templates explicitly reference it via `promptFile: ".sandcastle/prompt.md"`. This is a convention, not an automatic fallback — Sandcastle does not read `.sandcastle/prompt.md` unless you pass it as `promptFile`.

### Dynamic context with `` !`command` ``

Use `` !`command` `` expressions in your prompt to pull in dynamic context. Each expression is replaced with the command's stdout before the prompt is sent to the agent.

Commands run **inside the sandbox** after `onSandboxReady` hooks complete, so they see the same repo state the agent sees (including installed dependencies).

```markdown
# Open issues

!`gh issue list --state open --label Sandcastle --json number,title,body,comments,labels --limit 20`

# Recent commits

!`git log --oneline -10`
```

If any command exits with a non-zero code, the run fails immediately with an error.

### Prompt arguments with `{{KEY}}`

Use `{{KEY}}` placeholders in your prompt to inject values from the `promptArgs` option. This is useful for reusing the same prompt file across multiple runs with different parameters.

```typescript
import { run } from "@ai-hero/sandcastle";

await run({
  promptFile: "./my-prompt.md",
  promptArgs: { ISSUE_NUMBER: 42, PRIORITY: "high" },
});
```

In the prompt file:

```markdown
Work on issue #{{ISSUE_NUMBER}} (priority: {{PRIORITY}}).
```

Prompt argument substitution runs on the host before shell expression expansion, so `{{KEY}}` placeholders inside `` !`command` `` expressions are replaced first:

```markdown
!`gh issue view {{ISSUE_NUMBER}} --json body -q .body`
```

A `{{KEY}}` placeholder with no matching prompt argument is an error. Unused prompt arguments produce a warning.

### Built-in prompt arguments

Sandcastle automatically injects two built-in prompt arguments into every prompt:

| Placeholder         | Value                                                             |
| ------------------- | ----------------------------------------------------------------- |
| `{{SOURCE_BRANCH}}` | The branch the agent works on (determined by the branch strategy) |
| `{{TARGET_BRANCH}}` | The host's active branch at `run()` time                          |

Use them in your prompt without passing them via `promptArgs`:

```markdown
You are working on {{SOURCE_BRANCH}}. When diffing, compare against {{TARGET_BRANCH}}.
```

Passing `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs` is an error — built-in prompt arguments cannot be overridden.

### Early termination with `<promise>COMPLETE</promise>`

When the agent outputs `<promise>COMPLETE</promise>`, the orchestrator stops the iteration loop early. This is a convention you document in your prompt for the agent to follow — the engine never injects it.

This is only a stop signal. It does not imply semantic success. If your workflow needs stronger guarantees, encode concrete validation steps in the prompt or wrap `run()` with project-specific checks.

This is useful for task-based workflows where the agent should stop once it has finished, rather than running all remaining iterations.

You can override the default signal by passing `completionSignal` to `run()`. It accepts a single string or an array of strings:

```ts
await run({
  // ...
  completionSignal: "DONE",
});

// Or pass multiple signals — the loop stops on the first match:
await run({
  // ...
  completionSignal: ["TASK_COMPLETE", "TASK_ABORTED"],
});
```

Tell the agent to output your chosen string(s) in the prompt, and the orchestrator will stop when it detects any of them. The matched signal is returned as `result.completionSignal`.

For runtime-sensitive tasks, prefer prompts that require evidence such as build output, process health, or HTTP probes rather than allowing the agent to declare success without observable validation.

### Templates

`sandcastle init` prompts you to choose a template, which scaffolds a ready-to-use prompt and `main.mts` suited to a specific workflow. If your project's `package.json` has `"type": "module"`, the file will be named `main.ts` instead. Four templates are available:

| Template              | Description                                                             |
| --------------------- | ----------------------------------------------------------------------- |
| `blank`               | Bare scaffold — write your own prompt and orchestration                 |
| `simple-loop`         | Picks GitHub issues one by one and closes them                          |
| `sequential-reviewer` | Implements issues one by one, with a code review step after each        |
| `parallel-planner`    | Plans parallelizable issues, executes on separate branches, then merges |

Select a template during `sandcastle init` when prompted, or re-run init in a fresh repo to try a different one.

## CLI commands

### `sandcastle init`

Scaffolds the `.sandcastle/` config directory and builds the Docker image. This is the first command you run in a new repo.

| Option         | Required | Default                      | Description                                                          |
| -------------- | -------- | ---------------------------- | -------------------------------------------------------------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name                                                    |
| `--agent`      | No       | Interactive prompt           | Agent to use (`claude-code`, `pi`, `codex`)                          |
| `--model`      | No       | Agent's default model        | Model to use (e.g. `claude-sonnet-4-6`). Defaults to agent's default |
| `--template`   | No       | Interactive prompt           | Template to scaffold (e.g. `blank`, `simple-loop`)                   |

Creates the following files:

```
.sandcastle/
├── Dockerfile      # Sandbox environment (customize as needed)
├── prompt.md       # Agent instructions
├── .env.example    # Token placeholders
└── .gitignore      # Ignores .env, logs/
```

Errors if `.sandcastle/` already exists to prevent overwriting customizations.

### `sandcastle docker build-image`

Rebuilds the Docker image from an existing `.sandcastle/` directory. Use this after modifying the Dockerfile.

| Option         | Required | Default                      | Description                                                                       |
| -------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name                                                                 |
| `--dockerfile` | No       | —                            | Path to a custom Dockerfile (build context will be the current working directory) |

### `sandcastle docker remove-image`

Removes the Docker image.

| Option         | Required | Default                      | Description       |
| -------------- | -------- | ---------------------------- | ----------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name |

### `RunOptions`

| Option               | Type               | Default                       | Description                                                                                                             |
| -------------------- | ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `agent`              | AgentProvider      | —                             | **Required.** Agent provider (e.g. `claudeCode("claude-opus-4-6")`, `pi("claude-sonnet-4-6")`, `codex("gpt-5.4-mini")`) |
| `sandbox`            | SandboxProvider    | —                             | **Required.** Sandbox provider (e.g. `docker()`, `docker({ imageName: "sandcastle:local" })`)                           |
| `prompt`             | string             | —                             | Inline prompt (mutually exclusive with `promptFile`)                                                                    |
| `promptFile`         | string             | —                             | Path to prompt file (mutually exclusive with `prompt`)                                                                  |
| `maxIterations`      | number             | `1`                           | Maximum iterations to run                                                                                               |
| `hooks`              | object             | —                             | Lifecycle hooks (`onSandboxReady`)                                                                                      |
| `name`               | string             | —                             | Display name for the run, shown as a prefix in log output                                                               |
| `promptArgs`         | PromptArgs         | —                             | Key-value map for `{{KEY}}` placeholder substitution                                                                    |
| `copyToSandbox`      | string[]           | —                             | Host-relative file paths to copy into the sandbox before start (not supported with `branchStrategy: { type: 'head' }`)  |
| `logging`            | object             | file (auto-generated)         | `{ type: 'file', path }` or `{ type: 'stdout' }`                                                                        |
| `completionSignal`   | string \| string[] | `<promise>COMPLETE</promise>` | String or array of strings the agent emits to stop the iteration loop early                                             |
| `idleTimeoutSeconds` | number             | `600`                         | Idle timeout in seconds — resets on each agent output event                                                             |

### `RunResult`

| Field              | Type        | Description                                                        |
| ------------------ | ----------- | ------------------------------------------------------------------ |
| `iterationsRun`    | number      | Number of iterations that were executed                            |
| `completionSignal` | string?     | The matched completion signal string, or `undefined` if none fired |
| `stdout`           | string      | Agent output                                                       |
| `commits`          | `{ sha }[]` | Commits created during the run                                     |
| `branch`           | string      | Target branch name                                                 |
| `logFilePath`      | string?     | Path to the log file (only when logging to a file)                 |

### `ClaudeCodeOptions`

The `claudeCode()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: claudeCode("claude-opus-4-6", { effort: "high" });
```

| Option   | Type                                         | Default | Description                                             |
| -------- | -------------------------------------------- | ------- | ------------------------------------------------------- |
| `effort` | `"low"` \| `"medium"` \| `"high"` \| `"max"` | —       | Claude Code reasoning effort level (`max` is Opus only) |

Environment variables are resolved automatically from `.sandcastle/.env` and `process.env` — no need to pass them to the API. The required variables depend on the **agent provider** (see `sandcastle init` output for details).

## Custom Sandbox Providers

Sandcastle ships with a Docker provider, but you can create your own. A sandbox provider tells Sandcastle how to execute commands in an isolated environment. There are two kinds:

- **Bind-mount** — the sandbox can mount a host directory. Sandcastle creates a worktree on the host and the provider mounts it in. No file sync needed. Use this for Docker, Podman, or any local container runtime.
- **Isolated** — the sandbox has its own filesystem (e.g. a cloud VM). The provider handles syncing code in and out via `copyIn` and `copyOut`. Use this when the sandbox cannot access the host filesystem.

### The sandbox handle contract

Both provider types return a **sandbox handle** from their `create()` function. The handle exposes:

| Method          | Required | Description                                       |
| --------------- | -------- | ------------------------------------------------- |
| `exec`          | Both     | Run a command, return `ExecResult` when done      |
| `execStreaming` | Both     | Run a command, call `onLine` for each stdout line |
| `close`         | Both     | Tear down the sandbox                             |
| `copyIn`        | Isolated | Copy a file from the host into the sandbox        |
| `copyOut`       | Isolated | Copy a file from the sandbox to the host          |
| `workspacePath` | Both     | Absolute path to the workspace inside the sandbox |

### `ExecResult`

Every `exec` and `execStreaming` call returns an `ExecResult`:

```typescript
interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
```

### Bind-mount provider example

A minimal bind-mount provider that shells out to local processes (no container):

```typescript
import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
} from "@ai-hero/sandcastle";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const localProcess = () =>
  createBindMountSandboxProvider({
    name: "local-process",
    branchStrategy: { type: "merge-to-head" },
    create: async (
      options: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const workspacePath = options.worktreePath;

      return {
        workspacePath,

        exec: (command: string, opts?: { cwd?: string }): Promise<ExecResult> =>
          new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? workspacePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          }),

        execStreaming: (
          command: string,
          onLine: (line: string) => void,
          opts?: { cwd?: string },
        ): Promise<ExecResult> =>
          new Promise((resolve, reject) => {
            const proc = spawn("sh", ["-c", command], {
              cwd: opts?.cwd ?? workspacePath,
              stdio: ["ignore", "pipe", "pipe"],
            });

            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];

            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              stdoutChunks.push(line);
              onLine(line); // forward each line to Sandcastle
            });

            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });

            proc.on("error", (err) => reject(err));
            proc.on("close", (code) => {
              resolve({
                stdout: stdoutChunks.join("\n"),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              });
            });
          }),

        close: async () => {
          // nothing to tear down for a local process
        },
      };
    },
  });
```

### Isolated provider example

A minimal isolated provider using a temp directory:

```typescript
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
  type ExecResult,
} from "@ai-hero/sandcastle";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const tempDir = () =>
  createIsolatedSandboxProvider({
    name: "temp-dir",
    branchStrategy: { type: "merge-to-head" },
    create: async (): Promise<IsolatedSandboxHandle> => {
      const root = await mkdtemp(join(tmpdir(), "sandbox-"));
      const workspacePath = join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });

      return {
        workspacePath,

        exec: (command: string, opts?: { cwd?: string }): Promise<ExecResult> =>
          new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? workspacePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          }),

        execStreaming: (
          command: string,
          onLine: (line: string) => void,
          opts?: { cwd?: string },
        ): Promise<ExecResult> =>
          new Promise((resolve, reject) => {
            const proc = spawn("sh", ["-c", command], {
              cwd: opts?.cwd ?? workspacePath,
              stdio: ["ignore", "pipe", "pipe"],
            });

            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];

            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              stdoutChunks.push(line);
              onLine(line);
            });

            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });

            proc.on("error", (err) => reject(err));
            proc.on("close", (code) => {
              resolve({
                stdout: stdoutChunks.join("\n"),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              });
            });
          }),

        copyIn: async (hostPath: string, sandboxPath: string) => {
          await mkdir(dirname(sandboxPath), { recursive: true });
          await copyFile(hostPath, sandboxPath);
        },

        copyOut: async (sandboxPath: string, hostPath: string) => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },

        close: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });
```

### Branch strategies

A branch strategy controls where the agent's commits land. Configure it when constructing the provider:

| Strategy        | Behavior                                                                 | Bind-mount | Isolated  |
| --------------- | ------------------------------------------------------------------------ | ---------- | --------- |
| `head`          | Agent writes directly to the host working directory. No worktree created | Default    | N/A       |
| `merge-to-head` | Sandcastle creates a temp branch, merges back to HEAD when done          | Supported  | Default   |
| `branch`        | Commits land on an explicit named branch you provide                     | Supported  | Supported |

**When to use each:**

- **`head`** — fast iteration during development. No branch indirection, no merge step. Only works with bind-mount providers since the agent needs direct host filesystem access.
- **`merge-to-head`** — safe default for automation. The agent works on a throwaway branch; if something goes wrong, HEAD is untouched. Use this for CI or unattended runs.
- **`branch`** — when you want commits on a specific branch (e.g. for a PR). Pass `{ type: "branch", branch: "agent/fix-42" }`.

```typescript
// head — direct write, bind-mount only
const provider = localProcess();
// merge-to-head — temp branch, merge back (default for isolated)
const provider = tempDir();
// branch — explicit named branch
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
const provider = docker({
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
});
```

### Passing to `run()`

Pass your custom provider via the `sandbox` option — it works the same as the built-in `docker()` provider:

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";

const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: localProcess(), // your custom provider
  prompt: "Fix issue #42 in this repo.",
});
```

### Reference implementations

For real-world examples, see:

- [`src/sandboxes/docker.ts`](src/sandboxes/docker.ts) — bind-mount provider using Docker containers
- [`src/sandboxes/test-isolated.ts`](src/sandboxes/test-isolated.ts) — isolated provider using temp directories (used in tests)

## Configuration

### Config directory (`.sandcastle/`)

All per-repo sandbox configuration lives in `.sandcastle/`. Run `sandcastle init` to create it.

### Custom Dockerfile

The `.sandcastle/Dockerfile` controls the sandbox environment. The default template installs:

- **Node.js 22** (base image)
- **git**, **curl**, **jq** (system dependencies)
- **GitHub CLI** (`gh`)
- **Claude Code CLI**
- A non-root `agent` user (required — Claude runs as this user)

When customizing the Dockerfile, ensure you keep:

- A non-root user (the default `agent` user) for Claude to run as
- `git` (required for commits and branch operations)
- `gh` (required for issue fetching)
- Claude Code CLI installed and on PATH

Add your project-specific dependencies (e.g., language runtimes, build tools) to the Dockerfile as needed.

### Hooks

Hooks are arrays of `{ "command": "..." }` objects executed sequentially inside the sandbox. If any command exits with a non-zero code, execution stops immediately with an error.

| Hook             | When it runs               | Working directory      |
| ---------------- | -------------------------- | ---------------------- |
| `onSandboxReady` | After the sandbox is ready | Sandbox repo directory |

**`onSandboxReady`** runs after the sandbox is ready. Use it for dependency installation or build steps (e.g., `npm install`).

Pass hooks programmatically via `run()`:

```ts
await run({
  hooks: {
    onSandboxReady: [{ command: "npm install" }],
  },
  // ...
});
```

## Development

```bash
npm install
npm run build    # Build with tsgo
npm test         # Run tests with vitest
npm run typecheck # Type-check
```

## License

MIT
