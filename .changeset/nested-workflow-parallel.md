---
"@ai-hero/sandcastle": patch
---

Fix nested workflow `parallel` calls so local parallel work cannot deadlock behind the shared agent scheduler.
