---
"@ai-hero/sandcastle": patch
---

`sandbox.run({ logging: { type: "stdout" } })` on a `createSandbox()` sandbox now shows the agent's text, tool calls and run status in the terminal, as `run()` does. Before, it printed nothing unless `verbose` was on. Thanks @zero-two-rafaeltab!
