# Non-Windows worktree admin gitdir overlay

## Context

Bind-mount sandboxes mount the active worktree at
`/home/agent/workspace`. For `branch` and `merge-to-head`, Sandcastle creates
that worktree. The same shape can also appear in `head` mode when the caller's
host repo is itself a git worktree. In both cases, the worktree's `.git` file
points at the parent repo admin directory:

```text
gitdir: /path/to/repo/.git/worktrees/<name>
```

On macOS and Linux this forward pointer works because the parent `.git`
directory is mounted at the same absolute path inside the container.

Git also stores a reverse pointer at
`/path/to/repo/.git/worktrees/<name>/gitdir`. That file points back to the
host worktree path:

```text
/path/to/repo/.sandcastle/worktrees/<name>/.git
```

The host worktree path is not mounted inside the container. The worktree
contents are available at `/home/agent/workspace` instead. In-container git can
therefore see the admin entry as stale and rewrite or prune it. Because the
parent `.git` directory is bind-mounted read-write, that mutation corrupts host
worktree metadata.

## Decision

Before starting the sandbox, create a temp file containing the sandbox-side
worktree `.git` path:

```text
/home/agent/workspace/.git
```

Bind-mount that temp file over the parent admin back-pointer:

```text
/path/to/repo/.git/worktrees/<name>/gitdir
```

This keeps non-Windows forward `.git` resolution unchanged and only overlays
the reverse pointer that differs between the host and sandbox paths.

## Consequences

- macOS and Linux bind-mount worktree sandboxes no longer expose a stale admin
  `gitdir` back-pointer to in-container git.
- The parent `.git` directory remains mounted at its host path on non-Windows
  platforms, preserving the existing forward `gitdir:` behavior.
- A small temp file is created per worktree sandbox session and is left to
  normal OS temp cleanup.
- Windows continues to use ADR 0006's parent `.git` remap and forward `.git`
  overlay because Windows host paths are not valid Linux container paths.
