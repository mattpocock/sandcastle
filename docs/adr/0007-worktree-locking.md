# Worktree locking for concurrent access prevention

## Context

ADR 0003 introduced dirty-**worktree** reuse for the **branch** strategy: when a **worktree** already exists for a named branch, `WorktreeManager.create()` reuses it — logging for clean, warning for dirty. This removed the `throwOnDuplicateWorktree` guard, which had been incidentally preventing some concurrent access scenarios.

The consequence is that two `run()` or `interactive()` calls targeting the same named branch can both be handed the same **worktree** directory simultaneously. There is no mechanism to detect or prevent this — the collision detection in `WorktreeManager.create()` checks whether a **worktree** exists, not whether another process is currently using it.

The **merge-to-head** strategy is unaffected — timestamped branch names guarantee no collision.

## Decision

Add a file-based lock to prevent concurrent access to a **worktree**. The lock is an Effect-scoped resource: acquired when `WorktreeManager.create()` hands out a **worktree**, released when the scope finalizer runs (via `close()`, abort, or process exit).

### Lock location and naming

Lock files live in the **config directory** at `.sandcastle/locks/<name>.lock`, where `<name>` matches the **worktree** directory name under `.sandcastle/worktrees/<name>/`. This keeps locks separate from **worktree** contents (invisible to the **agent**) and provides a 1:1 mapping between **worktrees** and locks.

### Lock content

```json
{ "pid": 12345, "branch": "feature/auth", "acquiredAt": "2026-04-22T10:30:00Z" }
```

PID enables stale detection. Branch and timestamp aid debugging.

### Lock acquisition

Lock creation must be atomic (e.g. `fs.open` with `O_EXCL` flag or equivalent) to prevent the meta-race where two processes both observe "no lock" and both write. If the lock file already exists:

1. Read the PID from the lock file.
2. Check if the owning process is alive (`process.kill(pid, 0)`).
3. If alive — fail fast with a clear error: "Worktree is in use by process &lt;PID&gt;".
4. If dead — remove the stale lock and reacquire.

There is no wait/retry behavior. Contention means two callers targeted the same branch, which is a caller error. This is consistent with the project's fail-fast philosophy (see `.out-of-scope/provider-error-retry.md`).

### Lock release

The lock is released when the Effect scope closes — whether via `close()`, abort, error, or process exit. Release is independent of **worktree** state: a dirty **worktree** is preserved on disk for future reuse, but the lock is always released. The lock protects concurrent access to a **worktree**, not the **worktree**'s existence on disk.

### Stale lock cleanup

`pruneStale()` cleans up stale locks alongside orphaned **worktree** directories:

- Lock files whose corresponding **worktree** directory no longer exists — remove.
- Lock files whose owning PID is dead — remove.

### Scope

Only the **branch** strategy is affected. The **merge-to-head** strategy creates unique timestamped branches per run, so collisions are impossible. The **head** strategy operates on the **host** working directory, which is outside `WorktreeManager`'s purview.

### Rejected alternatives

- **Wait/retry on contention.** Adds complexity (backoff, timeout, cancellation) for a scenario that indicates a caller error. Consistent with the project's fail-fast philosophy.
- **Lock inside the worktree** (e.g. `<worktree-path>/.sandcastle.lock`). Visible to the **agent**, which could delete or commit it. Would require `.gitignore` management.
- **In-memory mutex/semaphore.** Only protects within a single Node process. The threat model is two separate processes — e.g. two `run()` calls from different terminals or CI jobs.

### In-process serialization (implemented ahead of the file lock)

The file lock above targets the **cross-process** threat model (two separate `sandcastle` processes). A distinct, **in-process** failure surfaced in #849: the `parallel-planner` template fires N concurrent `run()` calls on _different_ branches, and one run's destructive `pruneStale()` sweep would delete a sibling worktree that was still mid-`git worktree add` (its directory exists on disk before git has registered it), producing `fatal: not a git repository: .git/worktrees/…` and zero collected commits.

This is handled by a process-wide read/write lock in `WorktreeManager` (a counting semaphore): `create()` takes a single permit (reader) so sibling creates still run in parallel, while `pruneStale()` takes every permit (writer) so its sweep can never overlap an in-flight create. This is in-process only and does **not** supersede the file lock — two separate processes racing the same repo still need the `O_EXCL` file lock described above, which remains the cross-process follow-up.

## Consequences

- Two concurrent `run()` or `interactive()` calls targeting the same branch get a clear error on the second call, rather than silently sharing a **worktree**.
- The `.sandcastle/locks/` directory becomes a new managed directory in the **config directory**.
- A crashed process does not permanently lock a **worktree** — stale detection via PID liveness check ensures recovery.
- This closes the open thread from ADR 0003: "Worktree locking (#401) is a future mitigation for the concurrent-access risk this opens up."
