---
"@ai-hero/sandcastle": minor
---

Support cross-provider review. A new workflow option
`review.requireDifferentProvider` (default off) fails run admission when the
reviewer could run on a provider the implementer could also run on, including
fallbacks. The operator web and `applyCrossProviderReviewPreset` offer a preset
that sets a Claude Code reviewer (or Codex when the implementer uses Claude
Code) without changing defaults. When a role can run on Claude Code, init and
the operator create a `CLAUDE.md` importing `AGENTS.md` if none exists. Agent
Map details show provider, effort and fallback attempts per node.
