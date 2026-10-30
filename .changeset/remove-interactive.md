---
"@ai-hero/sandcastle": minor
---

**BREAKING:** Remove `interactive()`, `Worktree.interactive()` and `Sandbox.interactive()`, along with `InteractiveOptions`, `InteractiveResult`, `WorktreeInteractiveOptions`, `SandboxInteractiveOptions`, `SandboxInteractiveResult`, `InteractiveExecOptions`, the optional `AgentProvider.buildInteractiveArgs` and the optional `interactiveExec` on sandbox handles (see ADR 0021). Migration: there is no in-library replacement for a TTY agent session — create a worktree with `createWorktree()` and run the agent CLI yourself in `wt.worktreePath`, or use `run()` / `createSandbox()` + `sandbox.run()` for unattended work.
