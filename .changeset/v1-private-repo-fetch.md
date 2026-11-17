---
"@ai-hero/sandcastle": patch
---

v1 (`@ai-hero/sandcastle/v1/tasks`): bundled tasks work on private repos. Checking out a new branch from `base` fetched from `origin` without `githubToken`, so on a private repo `implement` with a `base` (and so every `implementSpec` ticket) failed with "Invalid username or token". `implement`, `review`, `implementSpec`, and `merge` from a pull request now also reject before they clone anything when the sandbox has no `gh` on its PATH, with a message saying so, rather than failing partway through.
