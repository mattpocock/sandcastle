# v1 sessions arm the completion timeout on the output's closing tag

Status: accepted for the v1 pre-release line.

Amends [ADR 0019](0019-completion-timeout-for-hanging-process.md). A v1 session (`sandbox.session()` / `spawnSession()`) has no completion signal: it is one agent on one prompt. Its completion marker is the closing tag of its structured output, `</${output.tag}>`. Once that has appeared in the agent's text, the idle timeout is replaced by the **completion timeout** (`completionTimeoutSeconds`, default 60); if the agent then stays silent that long, the session supervisor kills its process group and the session succeeds with exit reason `closing-tag`, its output extracted from what it printed. A session without `output` has no marker, so a hang rides the idle timeout and fails.

This is the rule an earlier, unreleased one-shot `run()` design proposed for the same reason, ported with its tests (closing tag then hang succeeds; opening tag alone doesn't arm it; no `output`, no trigger).

## Why the closing tag

It is the one in-band marker the caller already configured that means "the agent has produced what this session exists to produce". The payload ends at the marker, so nothing the session needs can trail it. A process still holding its output open after it is, by definition, hanging. The opening tag is not enough: the payload may still be streaming.

## Consequences

- An agent that quotes the literal closing tag mid-work and then goes silent for the completion timeout is cut short. Output resets the window, so only a genuinely silent period triggers it.
- Sessions without `output` have no hang protection beyond the idle timeout.
- `completionTimeoutSeconds` is a session option, so tests (and impatient callers) can shorten the window.
