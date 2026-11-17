---
"@ai-hero/sandcastle": minor
---

v1 (`@ai-hero/sandcastle/v1/tasks`): bundled tasks run side by side on one handle. `general`, `implement` and `review` take `name?: string`, which names the session, its record and its key in the finish report; `outputs` takes the same name (`implement.outputs("implement-1")`, `general.outputs(output, "ask")`) and keeps the task's name when it's left out. A start with a name other than the task's clones into a directory of that name, so two starts never share a working tree; without `name`, the clone stays in the repo-named directory. `start` rejects a name already running or starting on the handle, or one that can't name a directory, before it clones anything.
