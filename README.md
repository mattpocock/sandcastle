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
2. Sandcastle handles building worktrees and sandboxing the agent.
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

3. Edit `.sandcastle/.env` and fill in your default values for `ANTHROPIC_API_KEY`

```bash
cp .sandcastle/.env.example .sandcastle/.env
```

4. Run the `.sandcastle/main.ts` file with `npx tsx`

```bash
npx tsx .sandcastle/main.ts
```

```typescript
// 3. Run the agent via the JS API
import { run } from "@ai-hero/sandcastle";

await run({
  promptFile: ".sandcastle/prompt.md",
});
```

## API

Sandcastle exports a programmatic `run()` function for use in scripts, CI pipelines, or custom tooling.

```typescript
import { run } from "@ai-hero/sandcastle";

const result = await run({
  promptFile: ".sandcastle/prompt.md",
});

console.log(result.iterationsRun); // number of iterations executed
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

### All options

```typescript
import { run } from "@ai-hero/sandcastle";

const result = await run({
  // Prompt source — provide one of these, not both:
  promptFile: ".sandcastle/prompt.md", // path to a prompt file
  // prompt: "Fix issue #42 in this repo", // OR an inline prompt string

  // Values substituted for {{KEY}} placeholders in the prompt.
  promptArgs: {
    ISSUE_NUMBER: "42",
  },

  // Maximum number of agent iterations to run before stopping. Default: 1
  maxIterations: 5,

  // Branch the agent commits to inside the sandbox.
  branch: "agent/fix-42",

  // Agent provider to use. Default: "claude-code"
  // Available: "claude-code", "pi", "codex"
  agent: "claude-code",

  // Model passed to the agent. Default depends on agent provider.
  model: "claude-opus-4-6",

  // Docker image used for the sandbox. Default: "sandcastle:<repo-dir-name>"
  imageName: "sandcastle:local",

  // Display name for this run, shown as a prefix in log output.
  name: "fix-issue-42",

  // Lifecycle hooks — arrays of shell commands run sequentially inside the sandbox.
  hooks: {
    // Runs after the worktree is mounted into the sandbox.
    onSandboxReady: [{ command: "npm install" }],
  },

  // Host-relative file paths to copy into the worktree before the container starts.
  copyToSandbox: [".env"],

  // How to record progress. Default: write to a file under .sandcastle/logs/
  logging: { type: "file", path: ".sandcastle/logs/my-run.log" },
  // logging: { type: "stdout" }, // OR render an interactive UI in the terminal

  // String (or array of strings) the agent emits to end the iteration loop early.
  // Default: "<promise>COMPLETE</promise>"
  completionSignal: "<promise>COMPLETE</promise>",

  // Idle timeout in seconds — resets whenever the agent produces output. Default: 300 (5 minutes)
  idleTimeoutSeconds: 300,
});

console.log(result.iterationsRun); // number of iterations executed
console.log(result.completionSignal); // matched signal string, or undefined if none fired
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

## How it works

Sandcastle uses a worktree-based architecture for agent execution:

- **Worktree**: Sandcastle creates a git worktree on the host at `.sandcastle/worktrees/`. The worktree is a just a normal `git worktree`.
- **Bind-mount**: The worktree directory is bind-mounted into the sandbox container as the agent's working directory. The agent writes directly to the host filesystem through the mount.
- **No sync needed**: Because the agent writes directly to the host filesystem, there are no sync-in or sync-out operations. Commits made by the agent are immediately visible on the host.
- **Merge back**: After the run completes, the temp worktree branch is fast-forward merged back to the target branch, and the worktree is cleaned up.

From your point of view, you just run `sandcastle.run({ branch: 'foo' })`, and get a commit on branch `foo` once it's complete. All 100% local.

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

Commands run **inside the sandbox** after the worktree is mounted and `onSandboxReady` hooks complete, so they see the same repo state the agent sees (including installed dependencies).

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

| Placeholder         | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `{{SOURCE_BRANCH}}` | The branch the agent works on inside the worktree (temp or explicit) |
| `{{TARGET_BRANCH}}` | The host's active branch at `run()` time                             |

Use them in your prompt without passing them via `promptArgs`:

```markdown
You are working on {{SOURCE_BRANCH}}. When diffing, compare against {{TARGET_BRANCH}}.
```

Passing `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs` is an error — built-in prompt arguments cannot be overridden.

### Early termination with `<promise>COMPLETE</promise>`

When the agent outputs `<promise>COMPLETE</promise>`, the orchestrator stops the iteration loop early. This is a convention you document in your prompt for the agent to follow — the engine never injects it.

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

### Templates

`sandcastle init` prompts you to choose a template, which scaffolds a ready-to-use prompt and `main.ts` suited to a specific workflow. Four templates are available:

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

| Option         | Required | Default                      | Description                                   |
| -------------- | -------- | ---------------------------- | --------------------------------------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name                             |
| `--agent`      | No       | `claude-code`                | Agent provider (`claude-code`, `pi`, `codex`) |

Creates the following files:

```
.sandcastle/
├── Dockerfile      # Sandbox environment (customize as needed)
├── prompt.md       # Agent instructions
├── .env.example    # Token placeholders
└── .gitignore      # Ignores .env, patches/, logs/
```

Errors if `.sandcastle/` already exists to prevent overwriting customizations.

### `sandcastle build-image`

Rebuilds the Docker image from an existing `.sandcastle/` directory. Use this after modifying the Dockerfile.

| Option         | Required | Default                      | Description                                                                       |
| -------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name                                                                 |
| `--dockerfile` | No       | —                            | Path to a custom Dockerfile (build context will be the current working directory) |

### `sandcastle remove-image`

Removes the Docker image.

| Option         | Required | Default                      | Description       |
| -------------- | -------- | ---------------------------- | ----------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name |

### `RunOptions`

| Option               | Type               | Default                       | Description                                                                                   |
| -------------------- | ------------------ | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `prompt`             | string             | —                             | Inline prompt (mutually exclusive with `promptFile`)                                          |
| `promptFile`         | string             | —                             | Path to prompt file (mutually exclusive with `prompt`)                                        |
| `maxIterations`      | number             | `1`                           | Maximum iterations to run                                                                     |
| `hooks`              | object             | —                             | Lifecycle hooks (`onSandboxReady`)                                                            |
| `branch`             | string             | —                             | Target branch for sandbox work                                                                |
| `agent`              | string             | `"claude-code"`               | Agent provider (`"claude-code"`, `"pi"`, `"codex"`)                                           |
| `model`              | string             | provider-specific             | Model to use (claude-code: `claude-opus-4-6`, pi: `claude-sonnet-4-6`, codex: `gpt-5.4-mini`) |
| `imageName`          | string             | `sandcastle:<repo-dir-name>`  | Docker image name for the sandbox                                                             |
| `name`               | string             | —                             | Display name for the run, shown as a prefix in log output                                     |
| `promptArgs`         | PromptArgs         | —                             | Key-value map for `{{KEY}}` placeholder substitution                                          |
| `copyToSandbox`      | string[]           | —                             | Host-relative file paths to copy into the worktree before start                               |
| `logging`            | object             | file (auto-generated)         | `{ type: 'file', path }` or `{ type: 'stdout' }`                                              |
| `completionSignal`   | string \| string[] | `<promise>COMPLETE</promise>` | String or array of strings the agent emits to stop the iteration loop early                   |
| `idleTimeoutSeconds` | number             | `300`                         | Idle timeout in seconds — resets on each agent output event                                   |

### `RunResult`

| Field              | Type        | Description                                                        |
| ------------------ | ----------- | ------------------------------------------------------------------ |
| `iterationsRun`    | number      | Number of iterations that were executed                            |
| `completionSignal` | string?     | The matched completion signal string, or `undefined` if none fired |
| `stdout`           | string      | Agent output                                                       |
| `commits`          | `{ sha }[]` | Commits created during the run                                     |
| `branch`           | string      | Target branch name                                                 |
| `logFilePath`      | string?     | Path to the log file (only when logging to a file)                 |

Environment variables are resolved automatically from `.sandcastle/.env` and `process.env` — no need to pass them to the API. The required variables depend on the **agent provider** (see `sandcastle init` output for details).

## Configuration

### Config directory (`.sandcastle/`)

All per-repo sandbox configuration lives in `.sandcastle/`. Run `sandcastle init` to create it.

### Custom Dockerfile

The `.sandcastle/Dockerfile` controls the sandbox environment. The default template depends on the agent provider selected during `sandcastle init --agent`. Each provider installs its own CLI tool.

All templates share:

- **Node.js 22** (base image)
- **git**, **curl**, **jq** (system dependencies)
- **GitHub CLI** (`gh`)
- The selected agent CLI (Claude Code, pi, or Codex)
- A non-root `agent` user (required — the agent runs as this user)

When customizing the Dockerfile, ensure you keep:

- A non-root user (the default `agent` user) for the agent to run as
- `git` (required for commits and branch operations)
- `gh` (required for issue fetching)
- The agent CLI installed and on PATH

Add your project-specific dependencies (e.g., language runtimes, build tools) to the Dockerfile as needed.

### Hooks

Hooks are arrays of `{ "command": "..." }` objects executed sequentially inside the sandbox. If any command exits with a non-zero code, execution stops immediately with an error.

| Hook             | When it runs               | Working directory      |
| ---------------- | -------------------------- | ---------------------- |
| `onSandboxReady` | After the sandbox is ready | Sandbox repo directory |

**`onSandboxReady`** runs after the worktree is mounted into the sandbox. Use it for dependency installation or build steps (e.g., `npm install`).

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
