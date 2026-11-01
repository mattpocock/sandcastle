# How it works

Sandcastle uses a **branch strategy** configured on the sandbox provider to control how the agent's changes relate to branches. There are three strategies:

- **Head** (`{ type: "head" }`) — The agent writes directly to the host working directory. No worktree, no branch indirection. This is the default for bind-mount providers like `docker()`.
- **Merge-to-head** (`{ type: "merge-to-head" }`) — Sandcastle creates a temporary branch in a git worktree. The agent works on the temp branch, and changes are merged back to HEAD when done. The temp branch is cleaned up after merge. If the run fails, the temp branch is deleted too, unless the agent left commits on it: then it is kept, and Sandcastle prints how to merge or discard it. If the merge itself fails (for example on a conflict), Sandcastle aborts it so HEAD is unchanged and keeps the temp branch.
- **Branch** (`{ type: "branch", branch: "foo" }`) — Commits land on an explicitly named branch in a git worktree. Re-running with the same branch reuses the existing worktree and fast-forwards it from `origin` when safe — see [ADR 0003](../adr/0003-reuse-worktree-by-default.md).

For bind-mount providers (like Docker), the worktree directory is bind-mounted into the container — the agent writes directly to the host filesystem through the mount, so no sync is needed.

The repo's `.git` is mounted too, so the agent can commit. The files that decide what git runs are mounted read-only: `.git/config`, `.git/hooks`, `.git/info`, the worktree's `.git` file and its `commondir`. So `git config` without `--global` fails inside the sandbox. The git commands Sandcastle itself runs on the host ignore the repository's hooks and any repository config that names a program (fsmonitor, filter, diff and merge drivers, credential helpers, and so on); your global and system git config still applies. A custom bind-mount provider must honour `readonly` on the mounts it is given.

These protections cover the git commands Sandcastle runs. Git commands you run later in your own repo are outside Sandcastle's control: review the agent's changes before you run git commands that read repo config (`git status`, `git pull`, and so on) in a repo a sandbox has written to.

From your point of view, you just configure `branchStrategy: { type: 'branch', branch: 'foo' }` on `run()`, and get a commit on branch `foo` once it's complete. All 100% local.
