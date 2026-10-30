# Sandcastle feature map

What a user can do with Sandcastle, how to reach it inside a world, and the end state that proves it. Before you call a claim verified, find every entry here that reaches the same behaviour: a fix to worktree cleanup that you proved through `run()` is still unproved through `createSandbox().close()`.

Every entry gives the **entry point** (what the user calls) and the **proof** (what you read back afterwards: a file, a commit, a branch, an image, an exit code). Facts cite `src/` so you can recheck them when the code moves.

| Surface                                                              | File                                         |
| -------------------------------------------------------------------- | -------------------------------------------- |
| `sandcastle init`: flags, templates, issue trackers                  | [init.md](init.md)                           |
| `sandcastle docker\|podman build-image\|remove-image`                | [images.md](images.md)                       |
| `run()`, `createSandbox()`, `createWorktree()`                       | [entry-points.md](entry-points.md)           |
| Branch strategies: `head`, `merge-to-head`, `branch`                 | [branch-strategies.md](branch-strategies.md) |
| Sandboxes: docker, podman, vercel, daytona (and why never noSandbox) | [sandboxes.md](sandboxes.md)                 |
| Agents: claudeCode, pi, codex, cursor, opencode, copilot             | [agents.md](agents.md)                       |

## Driving the JS API in a world

The CLI has only `init` and the image commands (`src/cli.ts:692`); everything else is the JS API. Write a short script in the world's project that imports from `@ai-hero/sandcastle` (the packed build is installed there), commit it as a user would, and run it with the `tsx` verb. A script outside the project can't resolve the package.

Ask the agent for one fixed artefact (one file holding one line, one commit), so the model's wording never decides the verdict.

## Suspected from reading the source, never run

The mapping pass found these while reading code. Each is a hypothesis: a world run decides it.

- `createSandbox()` and `wt.createSandbox()` pass `agentProviderEnv: {}`, so env declared on the agent factory may never reach that container (`src/createSandbox.ts:606`, `:795`).
- `daytona()`'s `create` takes no arguments, so `.sandcastle/.env` keys may never reach a Daytona sandbox (`src/sandboxes/daytona.ts:84`).
- `run()` removes a clean worktree after a failure or an abort, though the `signal` doc says the worktree is preserved (`src/run.ts:407`).
- With merge-to-head, `run()`'s log filename and summary use a branch name that `WorktreeManager.create` then generates again, so the two may differ (`src/run.ts:639`, `src/SandboxFactory.ts:330`).
- `createWorktree({ branchStrategy: { type: "merge-to-head" } })` keeps its `sandcastle/<ts>-<hex>` branch across calls (README "createWorktree"), and nothing deletes it after `close()`. The ledger reports it as a temp branch left behind.
