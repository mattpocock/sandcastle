---
"@ai-hero/sandcastle": patch
---

Vercel sandbox provider: implement the `stdin` exec contract, and pass through `persistent` and `fetch` SDK options.

- `stdin` — agent providers (claudeCode, codex, …) deliver the prompt via exec's `stdin` option; the Vercel handle silently dropped it, so agents ran with an empty prompt. The content is now written into the sandbox and the command's stdin redirected from it.
- `persistent` — Vercel v2 sandboxes snapshot on stop by default (billed storage for 30 days); sandcastle sandboxes are one-per-run and never resumed, so callers can now pass `persistent: false`.
- `fetch` — lets callers inject a custom fetch for all sandbox API calls, e.g. forcing `accept-encoding: identity` to avoid intermittent `BrotliDecompressionError` under Bun on GitHub-hosted runners.
