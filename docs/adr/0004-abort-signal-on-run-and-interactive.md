# AbortSignal on run/interactive, not on factories

`run()`, `Worktree.run()`, `Sandbox.run()`, `interactive()`, `Worktree.interactive()`, and `Sandbox.interactive()` accept a `signal?: AbortSignal` option. When the signal fires, the in-flight agent subprocess is killed and the promise rejects with `signal.reason` (via `signal.throwIfAborted()`) — no Sandcastle-specific abort error class. The worktree and sandbox are **not** auto-torn-down on abort; they are preserved on disk, mirroring the existing error path so callers can inspect state or resume via `.close()` on their own terms.

The factory calls `createWorktree()` and `createSandbox()` deliberately do **not** accept a signal. Handles returned by factories are long-lived resources whose lifecycle is managed explicitly via `.close()`; binding cancellation to a resource's existence (rather than to a specific operation on it) was rejected as overloading two different concepts. Callers who want whole-session cancellation wire the same `AbortController` into each `.run()` / `.interactive()` call explicitly.

## Consequences

- Lifecycle hooks receive `signal` on their argument object so they can cooperatively abort their own async work. Hook authors opt in; existing hooks are unaffected.
- The existing process-level SIGINT/SIGTERM handler in `createSandbox.ts` is untouched — it handles process termination, which is a different concern from per-operation cancellation.
- Abort semantics match error semantics: worktree preserved, sandbox handle still alive on `Sandbox.run()` / `Worktree.run()`. Callers distinguish abort from other errors via `error.name === "AbortError"` (or by comparing to their own `signal.reason`).

## Amendment — `interactive()` removed (2026-10-30)

`interactive()`, `Worktree.interactive()` and `Sandbox.interactive()` were removed by [ADR 0021](0021-remove-interactive.md). The decision stands for `run()`, `Worktree.run()` and `Sandbox.run()`: they take a `signal`, the factories don't.
