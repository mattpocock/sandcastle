---
"@ai-hero/sandcastle": patch
---

Add `exe-dev` isolated sandbox provider. Each `run()` provisions a fresh exe.dev microVM via the exe.dev CLI (`ssh exe.dev …`) and tears it down on close. The same SSH key authenticates both the exe.dev CLI and VM access — no separate API key. Import via `@ai-hero/sandcastle/sandboxes/exe-dev`.
