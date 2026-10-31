# An agent provider may resume without forking

[ADR 0018](./0018-fork-is-session-only.md) assumed "any provider with `sessionStorage` can fork (it is one extra CLI flag)" and noted that a provider which resumes but cannot fork "would need a narrower per-provider signal added at that point". That point is here: the GitHub Copilot CLI (`copilot --resume=<id>`) and the Cursor CLI (`agent --resume <id>`) both resume a session, and neither has a fork flag.

## Decision

`AgentSessionStorage` gains an optional `canFork?: boolean`. A provider that resumes but has no native fork sets `canFork: false`. For such a provider, `.fork()` — and any `run()` or `sandbox.run()` given `forkSession` — throws a `ForkNotSupportedError` before any sandbox starts. The error carries `_tag` and `name` `"ForkNotSupportedError"` and an `agentProvider` field naming the provider, and its message points at `.resume()`.

Omitting `canFork` means the provider forks, so Claude Code, Codex and Pi are unchanged.

## Considered Options

1. **Emulate fork by copying the session under a new id.** Rejected. The agents key sessions by id inside the record (Copilot's `session.start` event, Cursor's chat store), so a copy under a new id means rewriting an undocumented format. Sandcastle would own a fork the agent never made.
2. **Silently resume in place when asked to fork.** Rejected. That is the bug #1125 fixed for pi: the parent session changes, which is exactly what fork promises not to do.
3. **Type `fork` as `never` for these providers.** Rejected for the reason ADR 0018 gives: `.resume()` is not typed that strictly either, and `RunResult` is not generic over the provider.
4. **A typed runtime error before the sandbox starts** (chosen). It costs nothing to run, names the provider, and keeps `.fork()` gated exactly like `.resume()`.

## Consequences

- The README says which providers fork, and that `fork` throws `ForkNotSupportedError` for the rest.
- `ForkNotSupportedError` is exported as a type (Effect stays out of the public `.d.ts`); callers match it on `_tag` or `name`.
- If Copilot or Cursor ship a fork flag, the provider drops `canFork: false` and wires the flag in `buildPrintCommand`.
