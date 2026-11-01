# Branch strategies

`branchStrategy` on `run()`, `interactive()` and `createWorktree()` (`src/SandboxProvider.ts:245-289`). With none given, `run()` and `interactive()` use **head** on bind-mount sandboxes (docker, podman) and **merge-to-head** on isolated ones (vercel, daytona) (`src/run.ts:508-512`). `createSandbox()` always uses an explicit branch.

Each strategy's proof starts from the host repo's branch and HEAD before the run, which the ledger's section (a) prints. Record them before you start.

## `{ type: "head" }`

- **What it does:**
  - No worktree. The project itself is bind-mounted at `/home/agent/workspace` (`src/SandboxFactory.ts:525-583`).
  - Isolated sandboxes reject it, as does `copyToWorktree` (`src/run.ts:516-532`).
- **Proof:**
  - The agent's commits are on the checked-out branch.
  - `commits` equals `git rev-list <before>..HEAD`.
  - No `.sandcastle/worktrees/` entry was ever created.
  - `preservedWorktreePath` is undefined.

## `{ type: "merge-to-head" }`

- **What it does** (`src/SandboxLifecycle.ts:408-511`):
  1. The agent works in a worktree on a temp branch `sandcastle/<YYYYMMDD-HHMMSS>-<6hex>` (or `sandcastle/<name>/…`).
  2. Afterwards the host runs a plain `git merge <temp>`, which fast-forwards or makes a merge commit.
  3. The host deletes the temp branch.
- **Proof:**
  - The new commits are on the checked-out branch.
  - No `sandcastle/*` branch remains; the ledger flags one left behind.
  - No worktree remains.
- **When the merge fails:** the temp branch is kept and a SyncError explains the recovery. Proving that path means making the host and the agent touch the same line.

## `{ type: "branch", branch, baseBranch? }`

- **What it does:**
  - Uses a worktree on `branch`, created from `baseBranch` (default HEAD) when the branch is new.
  - The commits stay on `branch`.
  - The checked-out branch never moves.
- **Proof:**
  - `git log <branch>` holds the commits.
  - `git rev-parse HEAD` is unchanged.
  - `branch` exists after the run.
  - No worktree remains.
- **When `branch` is already checked out in a `.sandcastle/worktrees/` worktree:** it is reused. A clean one is fast-forwarded from `origin/<branch>` (`src/WorktreeManager.ts:213-275`). The world's bare `origin` makes that fetch real.

## Isolated sandboxes on top

On vercel and daytona the worktree is synced in as a git bundle (`src/syncIn.ts`) and synced out as patches applied to the host worktree (`src/syncOut.ts:219-453`). The strategy then proceeds as above. A failed apply leaves `.sandcastle/patches/<ts>/` behind without failing the run (`:423-431`); the ledger reports it.
