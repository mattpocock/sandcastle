---
"@ai-hero/sandcastle": patch
---

The `.env.example` that `sandcastle init` writes for the GitHub Issues tracker now names the extra token permissions an agent needs to push branches and open pull requests (Contents and Pull requests, both read and write). It also scaffolds commented `GH_HOST` and `GH_ENTERPRISE_TOKEN` lines for GitHub Enterprise Server. Thanks to Adam Rackis and @Rakurai for the reports.
