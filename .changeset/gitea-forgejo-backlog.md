---
"@ai-hero/sandcastle": minor
---

Add Gitea Issues and Forgejo Issues as backlog manager choices in `sandcastle init`. The two share a single curl + jq based adapter because Forgejo is a soft-fork of Gitea and exposes the same `/api/v1` surface; only the env var names (`GITEA_*` vs `FORGEJO_*`) differ. Issue listing emits the same `{number, title, body, labels: [{name}], comments: [{body}]}` shape as the GitHub Issues path so existing templates work unchanged.
