# JS entry points

All four come from `@ai-hero/sandcastle`; sandboxes come from `@ai-hero/sandcastle/sandboxes/<name>`. Drive them from a committed script in the world's project, through the `tsx` verb.

## `run(options)` (`src/run.ts:482`)

```ts
const r = await run({
  agent: claudeCode("claude-haiku-5-5"),
  sandbox: docker(),
  prompt: "…",
});
```

- **Options:**
  - `agent` and `sandbox` are required.
  - `prompt` | `promptFile`. `promptFile` resolves against `process.cwd()`, not `cwd`.
  - `maxIterations`, default 1.
  - Also `branchStrategy`, `copyToWorktree`, `hooks`, `promptArgs`, `name`, `cwd`, `signal`, `output`, `resumeSession`, `logging`, `completionSignal`.
  - There is no `env` option.
- **Rejects before any setup on:**
  - head + an isolated sandbox.
  - head + `copyToWorktree`.
  - `resumeSession` + `maxIterations > 1`.
  - `output` + `maxIterations !== 1`.
  - An `output` tag the prompt never mentions.
  - An already-aborted `signal`.
- **Returns** `{ iterations, commits: {sha}[], branch, stdout, logFilePath?, preservedWorktreePath?, completionSignal?, output? }`.
- **Lifecycle:**
  - Each iteration gets a fresh worktree and container (`src/Orchestrator.ts:355`).
  - A clean worktree is removed after the iteration. A dirty one is kept, its path printed and returned as `preservedWorktreePath`.
  - The log is `<cwd>/.sandcastle/logs/<branch>[-name].log`.
- **Proof:**
  - `r.commits` matches `git rev-list` on `r.branch`.
  - The fixed artefact is at that branch's HEAD (`git show <branch>:<file>`).
  - The log ends `Run complete: agent finished after N iteration(s).`, or `…reached N iteration(s) without completion signal.` when the prompt never asks for `<promise>COMPLETE</promise>`. That is still a successful run.
  - The ledger shows no worktree and no container.

## `interactive(options)` (`src/interactive.ts:114`)

It hands the terminal to the agent's interactive CLI. The default sandbox is `noSandbox()` (`:122`), which a world never runs, so always pass a sandbox. An agent's shell has no TTY, so a claim about the interactive session itself is UNVERIFIABLE here: say "verify on a maintainer's machine". The parts around the session are provable from a script: argument collection, worktree setup, the commits returned, and `exitCode`.

## `createSandbox(options)` (`src/createSandbox.ts:904`)

```ts
await using sb = await createSandbox({ branch: "verify/x", sandbox: docker() });
const r = await sb.run({ agent: claudeCode("claude-haiku-5-5"), prompt: "…" });
```

- **Setup:**
  - It always uses an explicit branch, with `baseBranch` defaulting to HEAD.
  - The worktree and container start eagerly.
  - `sb.run()` reuses them across iterations and returns no `branch` and no `preservedWorktreePath`.
  - `sb.exec(cmd)` returns `{exitCode, stdout, stderr}` and never throws on a non-zero exit.
- **`close()`** (or `await using`):
  - Removes the container.
  - Removes the worktree when clean. When dirty, it keeps the worktree and returns `{ preservedWorktreePath }`.
  - Never deletes the branch.
- **Proof:**
  - The commits are on `verify/x`, and the host's checked-out branch didn't move.
  - After `close()`, the ledger shows no container and no worktree, and `verify/x` remains (expected).

## `createWorktree(options)` (`src/createWorktree.ts:215`)

```ts
await using wt = await createWorktree({
  branchStrategy: { type: "branch", branch: "verify/y" },
});
await wt.run({
  agent: claudeCode("claude-haiku-5-5"),
  sandbox: docker(),
  prompt: "…",
});
```

- **Strategies:** only `branch` or `merge-to-head`; `head` is a type error.
- **Paths:** the worktree is `.sandcastle/worktrees/<branch with / as ->`, or `sandcastle-<ts>-<hex>` for merge-to-head.
- **`wt.run()`:**
  - Takes `sandbox` (required) and `env`.
  - Starts one container for all its iterations.
  - Returns `{ commits, branch, … }` with no `preservedWorktreePath`.
- **Other handle methods:**
  - `wt.createSandbox()` returns a sandbox whose `close()` stops only its container.
  - `wt.interactive()` defaults to `noSandbox()`, which a world never runs, so always pass a sandbox.
- **`wt.close()`:** removes the worktree when clean, keeps it when dirty, and never deletes the branch.
- **Proof:**
  - The commits are on `wt.branch`.
  - With merge-to-head, they are also on the host's checked-out branch after each `wt.run()`.
  - After `close()`, the ledger shows no worktree. A merge-to-head `sandcastle/<ts>-<hex>` branch shows as a temp branch left behind: see the README's suspected list.
