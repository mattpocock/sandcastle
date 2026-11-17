---
"@ai-hero/sandcastle": minor
---

v1 (`@ai-hero/sandcastle/v1/tasks`): `implement.start` takes `base?: string`. With a new branch, the branch starts from `base`'s tip, fetched from `origin`, and the prompt tells the agent to open its PR against `base` (`gh pr create --base <base>`). A `base` the remote doesn't have rejects before the session starts. Without `base`, the task branches from and targets the default branch, as before. `base` is for a new branch only: with `branch`, the existing branch's PR keeps its base.
