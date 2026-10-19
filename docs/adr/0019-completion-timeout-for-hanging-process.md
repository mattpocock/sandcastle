# Completion timeout: force-complete a hanging process after the completion signal

When an agent emits the completion signal but its process does not exit — because a child it spawned (a subprocess like `gh`, or a long-lived MCP server) holds the sandbox exec's stdout open so EOF never arrives — Sandcastle previously hung until the full idle timeout (default 10 minutes) and then _failed_ the iteration with `AgentIdleTimeoutError`, discarding the already-committed work from the result. We now scan the agent's accumulated output stream for the completion signal and, once it is seen, replace the idle timeout with a one-minute **completion timeout**; if the process is still silent when that expires, we complete the iteration _successfully_ (collecting commits via the normal path) and warn that the process is **hanging**. A clean process exit within the window still completes normally, so healthy runs are unaffected and gain no added latency.

## Considered alternatives

- **Short-circuit on the agent's terminal stream event** rather than the signal string. Rejected: no reliable terminal event exists across providers. Claude Code emits a single terminal `result` event, but Sandcastle synthesizes a `result` event for _every_ agent message for Codex (`AgentProvider.ts:551`) and OpenCode (`715`), so keying on it would terminate those agents after their first message. Building a real per-provider terminal event is larger work than this bug warrants.
- **Kill the process immediately on signal detection.** Rejected: useful data trails the signal — Codex's token usage rides on `turn.completed`, Claude Code's canonical `result` text comes last, and a run using both completion signal and structured output may emit the `<tag>` payload after the marker. The silence-based window captures trailing output before giving up.

## Scope

The completion timeout is gated strictly on the completion signal. A process that hangs _before_ any signal is emitted is indistinguishable from an agent genuinely stuck mid-work, so it still rides the full idle timeout and fails.

## Consequences

Force-completing abandons the hanging process. For container-based sandbox providers, container teardown (`docker rm -f`) kills it. For the no-sandbox provider, `close()` is a no-op and there is no `proc.kill()` anywhere in the codebase, so the abandoned agent process and its children leak on the host. This extends an existing timeout/abort-path leak to the common success case and may warrant an explicit process kill in follow-up.

## Amendment — trigger depends on the entry point

After the `run()`/`runMany()` split ([ADR 0022](0022-split-run-into-run-and-runmany.md)) only `runMany()` has a completion signal. It keeps this ADR's signal-based trigger. One-shot `run()` arms the completion timeout on the structured-output closing tag instead, and has no trigger at all without `output` — see [ADR 0021](0021-run-completion-timeout-on-output-closing-tag.md).
