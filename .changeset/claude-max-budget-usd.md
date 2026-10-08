---
"@ai-hero/sandcastle": patch
---

Add `maxBudgetUsd` option to `claudeCode()` — threads Claude's `--max-budget-usd` flag through print and interactive commands so runs abort once their API cost exceeds the cap.
