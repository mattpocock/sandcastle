# Branch strategies

> **Branch strategy**: Configuration on a **sandbox provider** that controls how the agent's changes relate to branches, set at provider construction time.

> **Head (branch strategy)**: A **branch strategy** where the **agent** works directly in the **host** working directory -- no **worktree**, no branch indirection.

> **Merge-to-head (branch strategy)**: A **branch strategy** where Sandcastle creates a temporary branch, the agent works on it, and changes are merged back to HEAD.

> **Branch (branch strategy)**: A **branch strategy** where commits land on an explicitly named branch provided by the caller.

> **Worktree**: A git worktree created in `.sandcastle/worktrees/` on the **host**, used by the **merge-to-head** and **branch** strategies. For **bind-mount sandbox providers**, the **worktree** is mounted into the **sandbox**. For **isolated sandbox providers**, the **worktree** is the sync source/destination -- commits from the **sandbox** are pulled back into the **worktree**. Created explicitly via `createWorktree()` or implicitly by `run()`/`interactive()` when using a non-**head** **branch strategy**.

> **Source branch**: The branch the **agent** works on -- determined by the **branch strategy**.

> **Target branch**: The **host**'s active branch at `run()` time -- the branch Sandcastle merges into when using **merge-to-head**.

Pass `branchStrategy` to `run()`. Here the agent's commits land on `agent/fix-42`, in a worktree under `.sandcastle/worktrees/`:

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  prompt: "Fix issue #42 in this repo.",
});

console.log(result.commits); // array of { sha } for commits created
```

## How it works

Sandcastle uses a **branch strategy** configured on the sandbox provider to control how the agent's changes relate to branches. There are three strategies:

- **Head** (`{ type: "head" }`) — The agent writes directly to the host working directory. No worktree, no branch indirection. This is the default for bind-mount providers like `docker()`.
- **Merge-to-head** (`{ type: "merge-to-head" }`) — Sandcastle creates a temporary branch in a git worktree. The agent works on the temp branch, and changes are merged back to HEAD when done. The temp branch is cleaned up after merge. If the run fails, the temp branch is deleted too, unless the agent left commits on it: then it is kept, and Sandcastle prints how to merge or discard it. If the merge itself fails (for example on a conflict), Sandcastle aborts it so HEAD is unchanged and keeps the temp branch.
- **Branch** (`{ type: "branch", branch: "foo" }`) — Commits land on an explicitly named branch in a git worktree. Re-running with the same branch reuses the existing worktree and fast-forwards it from `origin` when safe — see [ADR 0003](../adr/0003-reuse-worktree-by-default.md).

For bind-mount providers (like Docker), the worktree directory is bind-mounted into the container — the agent writes directly to the host filesystem through the mount, so no sync is needed.

The repo's `.git` is mounted too, so the agent can commit. The files that decide what git runs are mounted read-only: `.git/config`, `.git/hooks`, `.git/info`, the worktree's `.git` file and its `commondir`. So `git config` without `--global` fails inside the sandbox. The git commands Sandcastle itself runs on the host ignore the repository's hooks and any repository config that names a program (fsmonitor, filter, diff and merge drivers, credential helpers, and so on); your global and system git config still applies. A custom bind-mount provider must honour `readonly` on the mounts it is given.

These protections cover the git commands Sandcastle runs. Git commands you run later in your own repo are outside Sandcastle's control: review the agent's changes before you run git commands that read repo config (`git status`, `git pull`, and so on) in a repo a sandbox has written to.

From your point of view, you just configure `branchStrategy: { type: 'branch', branch: 'foo' }` on `run()`, and get a commit on branch `foo` once it's complete. All 100% local.

## Choosing a strategy

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

Branch strategy is now configured on `run()`, not on the provider:

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// head — direct write, bind-mount only (default for bind-mount providers)
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "…",
});
// merge-to-head — temp branch, merge back (default for isolated providers)
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: tempDir(),
  prompt: "…",
});
// branch — explicit named branch
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  prompt: "…",
});
```

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

## Source and target branches

Every prompt template gets the source branch and the target branch as the built-in prompt arguments `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}`: see [Built-in prompt arguments](./prompts.md#built-in-prompt-arguments).

## Related terms

- [Sandbox providers](./sandbox-providers.md): bind-mount and isolated providers, and each one's default strategy
- [Prompts](./prompts.md#built-in-prompt-arguments): `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}`
- [Agent sessions](./agent-sessions.md#session-fork): why concurrent forks need a distinct `branch` each
- [Hooks](./hooks.md): `host.onWorktreeReady`, which runs in the worktree
- [`run()` reference](./run.md#runoptions): `branchStrategy`, `copyToWorktree` and `timeouts`
