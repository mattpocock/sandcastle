---
"@ai-hero/sandcastle": patch
---

Kill the `cp` child process when `copyToWorktree` times out. Previously the timeout failed the Effect but left `cp` running, so an orphaned copy kept writing into a worktree the caller had already begun tearing down. The copy-on-write attempt's callback could also spawn its `cp -R` fallback after the timeout had already fired.
