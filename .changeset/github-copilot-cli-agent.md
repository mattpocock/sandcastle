---
"@ai-hero/sandcastle": patch
---

Add a `copilot` agent provider for [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) (`@github/copilot`). Use it like the other agent factories: `copilot("claude-sonnet-4.5")`. Authentication is via `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`. `sandcastle init` now offers GitHub Copilot CLI as an agent option, with a Dockerfile that installs the CLI via `npm install -g @github/copilot`.
