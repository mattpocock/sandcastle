---
"@ai-hero/sandcastle": minor
---

v1 (`@ai-hero/sandcastle/v1`): reuse a sandbox after a detach. The session supervisor still exits once a detach's finish report is delivered (or given up), so nothing runs while you wait between steps. A handle from `reattachSandbox` on such a sandbox now starts a new supervisor in it on its first `session`, `spawnSession` or `detach`, where those used to reject, so you can spawn the next step's sessions and `detach()` again, with a new `detachId`, deadline and finish report each time. While a detach's work is still running, a reattached handle's new sessions still reject. `status()` gains `detaches`, every detach with its finish report, oldest first, kept across supervisor restarts; `detached` is still the last one. The new `DetachStatus` type names one entry.
