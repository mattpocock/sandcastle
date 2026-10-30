# Remove `interactive()`

## Context

Sandcastle had three ways to hand the terminal to an agent's own TUI: the top-level `interactive()`, `Worktree.interactive()` and `Sandbox.interactive()`. They needed their own plumbing through every layer: `buildInteractiveArgs` on each **agent provider**, `interactiveExec` (a TTY-attached exec) on each **sandbox provider** handle, and a third copy of the worktree, prompt and lifecycle setup that `run()` and `createSandbox()` already own.

That copy drifted. On 2026-10-30 verification found two bugs in `interactive()` that `run()` does not have: on a setup failure it removed the **worktree** even when it was dirty, and in **branch** mode it ignored `baseBranch`. An agent's shell has no TTY either, so the interactive session itself could never be verified the way the rest of the API is.

## Decision

Remove `interactive()` completely, on 2026-10-30. Sandcastle drives agents unattended; a human driving an agent's TUI runs that agent's CLI themselves.

Removed with it, because nothing else used them:

- `interactive()`, `InteractiveOptions` and `InteractiveResult`.
- `Worktree.interactive()` and `WorktreeInteractiveOptions`.
- `Sandbox.interactive()`, `SandboxInteractiveOptions` and `SandboxInteractiveResult`.
- `AgentProvider.buildInteractiveArgs` and its implementation on every built-in agent provider.
- `interactiveExec` on `BindMountSandboxHandle`, `IsolatedSandboxHandle` and `NoSandboxHandle`, its implementations in `docker()`, `podman()` and `noSandbox()`, and the `InteractiveExecOptions` type.
- `findMissingPromptArgKeys` and `raceAbortSignal`, internal helpers only `interactive()` called.

There is no in-library replacement for a TTY session inside a sandbox. To work in a worktree yourself, create it with `createWorktree()` and launch the agent CLI in `wt.worktreePath`; for unattended work, use `run()` or `createSandbox()` + `sandbox.run()`.

## Consequences

- A breaking change, shipped pre-1.0 as a `minor` changeset.
- Custom agent providers or sandbox providers that implement `buildInteractiveArgs` or `interactiveExec` must drop them: an object literal typed as `AgentProvider` or a handle with the extra method no longer type-checks.
- The two bugs above go away with the code that had them.
- ADRs 0002, 0004, 0007, 0008, 0010 and 0015 mention `interactive()`. They stay as written, each with an amendment pointing here.
