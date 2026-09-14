# Git worktree mounts on Windows hosts

## Context

When a sandbox runs inside a Linux container on a **Windows host**, git worktree
mounts break in two distinct ways. This affects any configuration where a `.git`
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

## Decision

Fix both problems by patching the git mounts before container creation:

1. **Mount the parent `.git` dir at a deterministic POSIX path** —
   `/.sandcastle-parent-git`. This gives the parent git directory a stable,
   valid location inside the sandbox.

2. **Create a corrected `.git` file** with the `gitdir:` path rewritten to
   match the deterministic mount point, e.g.,
   `gitdir: /.sandcastle-parent-git/worktrees/abc`. Mount this file at
   `SANDBOX_REPO_DIR/.git` as a Docker **overlay mount** — a file bind-mount
   that overrides the original `.git` file from the worktree directory mount.

Both corrections happen before the container starts, so git operations work from
the moment the sandbox is available. No post-start patching or exec is needed.

### `patchGitMountsForWindows`

A new Effect-based function in `mountUtils.ts` sits between `resolveGitMounts`
and `startSandbox`. It:

1. Short-circuits on non-Windows platforms (returns mounts unchanged).
2. Reads the worktree's `.git` file to extract the `gitdir:` path.
3. Parses the worktree name and parent `.git` dir from the `gitdir:` path.
4. Creates a temp file with the corrected `gitdir:` content.
5. Remaps the parent `.git` dir mount to `/.sandcastle-parent-git`.
6. Adds (or replaces) a mount for the corrected `.git` file at
   `SANDBOX_REPO_DIR/.git`.

For a valid worktree pointer, `resolveGitMounts` returns only the shared parent
`.git` directory. The workspace directory mount already includes its `.git`
file, so that pointer does not need a second identity mount at its host path.
This also avoids leaking an unrelated host checkout's pointer into the mount
list when Sandcastle creates a new sandbox from an existing linked worktree.

In both head mode and Sandcastle-created worktree mode, the patcher adds an
overlay for the **active workspace's** pointer. It still supports replacing an
explicit pointer mount if one is supplied. The original host pointer is never
rewritten.

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
- A small temp file is created per sandbox session. It is cleaned up when the
  worktree is removed; for head mode it persists in the OS temp directory until
  normal temp cleanup.
- The `/.sandcastle-parent-git` path is reserved inside the sandbox. This is
  unlikely to conflict with anything, but it's a new convention that providers
  and container images should not use for other purposes.
