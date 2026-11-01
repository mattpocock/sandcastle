# The context window is the last model call's input, never a total

## Context

The end-of-run `Context window: NNNk` line had no single rule, so each agent got it wrong in its own way (verified 2026-10-31 at `4518681`, issue #898 for codex, #863 for pi):

- claudeCode was right only when Sandcastle captured the session file (docker and podman). noSandbox, vercel and `captureSessions: false` showed nothing.
- codex used `turn.completed.usage`, which sums every request of the session: `175k` shown when the last request was ~32k.
- pi, opencode, copilot and cursor showed nothing.

Every agent reports some token total that looks like the answer and isn't: Claude Code's `result.usage`, codex's `turn.completed`, pi's `agent_end.messages[]`, copilot's `modelMetrics[...].usage.inputTokens`, cursor's `result.usage`. Each is summed over the calls of a turn or a session, so it grows with every tool round-trip and can exceed the model's window.

## Decision

An iteration's context window is the input side of its **last** model call, with cache reads and cache writes included. Each call's input already holds the whole conversation so far, so the last call is the context size.

- Parsers only extract: each emits one `context_window` event per model call. The Orchestrator keeps the last one per iteration, and that is `IterationResult.contextWindow`.
- An agent with no per-call figure in its stream may read it from its captured session instead (`parseSessionContextWindow`). Only codex does: its rollout's last `token_count` event has `last_token_usage`.
- The model's limit is shown (`34k / 258k`) only when the agent itself reports it, as codex's `model_context_window` does. This keeps ADR 0005's rule: no model-to-limit lookup table.
- Cursor reports only a whole-turn total, so it shows no line. No line beats a wrong one.
- When an iteration fails, the lines for the iterations that finished are still shown.

`IterationResult.usage` keeps its raw counts unchanged; it is no longer what the line shows.

## Considered Options

- **Sum the calls of the turn** (the #965 and #1011 approach). Rejected: that is the total, the same overstatement as #898.
- **Use cursor's `inputTokens` alone** as an approximation. Rejected: it is still summed over calls, and the match with the real context is an inference.
- **Use Claude Code's `modelUsage[...].contextWindow`** as its limit. Not done: ADR 0005 records that this value is wrong for some models.
