---
"@ai-hero/sandcastle": patch
---

The `.env.example` that `sandcastle init` writes for the GitHub Issues tracker now names the extra token permissions an agent needs to push branches and open pull requests (Contents and Pull requests, both read and write). It also scaffolds `GH_HOST` (and a commented `GH_ENTERPRISE_TOKEN`) for GitHub Enterprise Server. Thanks to Adam Rackis and @Rakurai for the reports.
