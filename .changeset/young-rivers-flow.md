---
"@ai-hero/sandcastle": minor
---

Sandcastle now exposes the public contract types, errors, loader, source validation API, scheduler, run persistence, JSON Schema validation adapter, Sandcastle-backed agent runner API, workflow primitives factory, and `runWorkflow` runtime entry point for dynamic workflows.

Failed workflow agent calls now surface `output` as absent and persist available run/log metadata for audit.
