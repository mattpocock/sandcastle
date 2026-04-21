---
"@ai-hero/sandcastle": patch
---

Fix `spawn E2BIG` when the Claude Code prompt exceeds Linux's per-argv-string limit (`MAX_ARG_STRLEN`, 128 KB). Adds an opt-in stdin transport for the agent prompt so large prompts no longer fail at the kernel `execve` boundary.

- `AgentProvider` gains an optional `buildPrintInvocation(options)` method returning `{ command, stdin? }`. When set, the orchestrator pipes `stdin` into the child process instead of inlining the prompt in argv. `claudeCode()` implements it (Claude Code's `--print` mode reads the prompt from stdin when no prompt argument is supplied).
- Sandbox handles gain an optional `supportsStdinExec` flag. Docker, Podman, and the no-sandbox provider set it to `true` and forward the `stdin` option to the spawned child (via `docker exec -i` / `podman exec -i` / a piped stdin). Remote providers (Vercel, Daytona) leave it unset and behaviour is unchanged.
- The orchestrator selects the stdin path only when both the agent provider implements `buildPrintInvocation` **and** the sandbox reports `supportsStdinExec`. Otherwise it falls back to the existing argv-based `buildPrintCommand`, so behaviour for non-Claude agents and non-local sandboxes is unchanged.

Closes the failure mode where a sufficiently large prompt (e.g. a `plan-prompt.md` that inlines every open GitHub issue via `!\`gh issue list ...\``) causes the orchestrator's `sandbox.exec(...)` to reject with `ExecError: exec failed: spawn E2BIG`.
