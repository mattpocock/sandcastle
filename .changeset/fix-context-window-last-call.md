---
"@ai-hero/sandcastle": minor
---

Fix the `Context window: NNNk` line so it shows the last model call's input tokens (cache included) for every agent, never a running total. claudeCode now reads it from the stream, so it also shows on noSandbox, vercel and with `captureSessions: false`. codex reads it from its captured session instead of the cumulative `turn.completed` total, and shows the model's limit (`34k / 258k`). pi, opencode and copilot now show it. cursor shows none, because it reports only a whole-turn total. When an iteration fails, the line still shows for the iterations that finished. New `IterationResult.contextWindow` (`{ tokens, limit? }`).
