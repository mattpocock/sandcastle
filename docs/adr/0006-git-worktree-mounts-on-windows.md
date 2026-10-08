# Git worktree mounts on Windows hosts

## Context

When a sandbox runs inside a Linux container on a **Windows host**, git worktree
mounts break in three distinct ways. This affects any configuration where a `.git`
file (worktree pointer) must resolve inside the container — both when the **host
repo itself is a worktree** and when Sandcastle **creates a worktree** via the
`merge-to-head` or `branch` strategies.

### How git worktrees work

A normal repo has a `.git` **directory**. A git worktree has a `.git` **file**
containing a `gitdir:` pointer to the parent repo's `.git/worktrees/<name>/`
directory. Git reads this pointer to find the actual object store, refs, and
per-worktree state (HEAD, index).

### Problem 1: parent `.git` dir has no valid sandbox path

`resolveGitMounts` returns mount entries with `sandboxPath === hostPath`. On
Linux, this is fine — the parent `.git` dir is mounted at its original host path,
and the `gitdir:` pointer resolves. On Windows, the host path is something like
`C:\Users\project\.git`. This path is **not under the worktree**, so
`normalizeMounts` can't remap it relative to `SANDBOX_REPO_DIR` — it falls
through to just normalizing backslashes, producing `C:/Users/project/.git` as
the sandbox path.

While Docker will technically create a mount at `C:/Users/project/.git`, the
`.git` file's `gitdir:` value won't point there (see Problem 2).

### Problem 2: `.git` file contains Windows `gitdir:` paths

The worktree's `.git` file contains a host-native path:

```
gitdir: C:\Users\project\.git\worktrees\abc
```

Git inside the Linux container reads this and treats `C:\Users\...` as a
relative path (since it doesn't start with `/`). The path can't resolve
regardless of where the parent `.git` dir is mounted.

### Problem 3: admin `gitdir` file points back to the Windows worktree path

Git also stores a back-pointer at
`<parent>/.git/worktrees/<name>/gitdir`. That file contains the worktree's
host-native `.git` path:

```
C:\Users\project\.sandcastle\worktrees\abc\.git
```

The parent `.git` directory is bind-mounted read-write into the container, so
this admin file is visible to in-container git. Because the Windows path does
not exist in the Linux sandbox, in-container git can treat the worktree as stale
and prune the parent admin entry. That deletion lands on the host through the
bind mount, leaving the Sandcastle worktree orphaned.

## Decision

Fix all three problems by patching the git mounts before container creation:

1. **Mount the parent `.git` dir at a deterministic POSIX path** —
   `/.sandcastle-parent-git`. This gives the parent git directory a stable,
   valid location inside the sandbox.

2. **Create a corrected `.git` file** with the `gitdir:` path rewritten to
   match the deterministic mount point, e.g.,
   `gitdir: /.sandcastle-parent-git/worktrees/abc`. Mount this file at
   `SANDBOX_REPO_DIR/.git` as a Docker **overlay mount** — a file bind-mount
   that overrides the original `.git` file from the worktree directory mount.

3. **Create a corrected admin back-pointer file** containing the sandbox-side
   worktree `.git` path, e.g. `/home/agent/workspace/.git`. Mount this file at
   `/.sandcastle-parent-git/worktrees/abc/gitdir` so in-container git validates
   the worktree against the sandbox path instead of pruning it as stale.

All corrections happen before the container starts, so git operations work from
the moment the sandbox is available. No post-start patching or exec is needed.

### `patchGitMountsForWindows`

A new Effect-based function in `mountUtils.ts` sits between `resolveGitMounts`
and `startSandbox`. It:

1. Short-circuits on non-Windows platforms (returns mounts unchanged).
2. Reads the worktree's `.git` file to extract the `gitdir:` path.
3. Parses the worktree name and parent `.git` dir from the `gitdir:` path.
4. Creates a temp file with the corrected `gitdir:` content.
5. Creates a temp file with the corrected admin back-pointer content.
6. Remaps the parent `.git` dir mount to `/.sandcastle-parent-git`.
7. Adds (or replaces) a mount for the corrected `.git` file at
   `SANDBOX_REPO_DIR/.git`.
8. Adds a mount for the corrected admin back-pointer at
   `/.sandcastle-parent-git/worktrees/<name>/gitdir`.

The function handles both scenarios:

- **Host repo is a worktree** — replaces the `.git` file mount already in
  `gitMounts` from `resolveGitMounts`.
- **Sandcastle-created worktree** — adds a new overlay mount, since the `.git`
  file is part of the worktree directory mount rather than a separate entry.

### Rejected alternatives

- **Post-start exec patching**: Rewrite the `.git` file via `handle.exec()`
  after the container starts. Rejected because there is a timing window —
  `SandboxLifecycle` may run git commands (config setup, hooks) before the patch
  is applied. Pre-start overlay mount avoids this entirely.

- **Entrypoint script**: Have the container's init script detect and rewrite
  Windows paths. Rejected because it pushes Sandcastle-specific logic into the
  container image, making images less portable and harder to debug.

- **Fall back to isolated mode on Windows**: Detect the broken case and use
  git-bundle sync instead of bind-mounts. This works but sacrifices bind-mount
  performance for a problem that has a direct fix.

## Consequences

- Windows hosts using `merge-to-head` or `branch` strategies with bind-mount
  providers will now work correctly (previously fully broken).
- The `head` strategy on Windows is also fixed for the case where the host repo
  itself is a git worktree (previously broken for the same reasons).
- Small temp files are created per sandbox session. Sandcastle does not track
  them for explicit deletion, so they remain in the OS temp directory until
  normal temp cleanup.
- The `/.sandcastle-parent-git` path is reserved inside the sandbox. This is
  unlikely to conflict with anything, but it's a new convention that providers
  and container images should not use for other purposes.
