---
"@ai-hero/sandcastle": patch
---

`sandcastle init --issue-tracker beads` now checks the host's `bd version` against the image's pinned bd 1.3.2 and warns on a mismatch. Every beads sandbox opens the host's `.beads/` with the image's bd, which migrates the database; an older host bd then fails to create issues (`fk_events_issue`). The warning names both versions and says which one to change.
