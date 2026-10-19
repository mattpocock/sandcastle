---
"@ai-hero/sandcastle": patch
---

Stop accumulating duplicate `safe.directory` entries in the global git config. Sandbox setup previously ran `git config --global --add safe.directory <worktree>` unconditionally on every run, so the entry piled up — most visibly with the no-sandbox provider, which writes to the developer's real `~/.gitconfig`. Setup now reads the existing entries first and only appends when the directory isn't already registered.
