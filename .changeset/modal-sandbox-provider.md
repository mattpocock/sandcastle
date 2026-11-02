---
"@ai-hero/sandcastle": minor
---

Add `modal()`, an isolated sandbox provider for [Modal](https://modal.com) sandboxes, at `@ai-hero/sandcastle/sandboxes/modal`. Install `modal` (an optional peer dependency) and set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, or pass `tokenId` and `tokenSecret`. By default it builds a `node:24-bookworm` image with Claude Code installed; pass `image` for your own. Sandboxes live for an hour unless `timeoutMs` says otherwise, and `sandboxId` is the Modal sandbox id.
