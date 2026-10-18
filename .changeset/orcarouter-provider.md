---
"@ai-hero/sandcastle": minor
---

Add a named `orcarouter` agent provider. It runs the OpenCode CLI with `orcarouter/*` model ids routed through the [OrcaRouter](https://www.orcarouter.ai) gateway (`https://api.orcarouter.ai/v1`) and injects `ORCAROUTER_API_KEY` into the sandbox. Default model is `orcarouter/auto`, which routes adaptively through the gateway. Also available via `sandcastle init` (`--agent orcarouter`).
