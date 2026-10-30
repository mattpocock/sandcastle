---
"@ai-hero/sandcastle": patch
---

Validate timeout options up front: `idleTimeoutSeconds`, `completionTimeoutSeconds` and every `timeouts.*Ms` key now reject zero, negative or `NaN` values with an error naming the option, before any worktree or sandbox is created. Error messages no longer point to CLI flags that don't exist: the idle-timeout error names the `idleTimeoutSeconds` option (not `--idle-timeout`), and passing both prompt sources says `prompt` and `promptFile` (not `--prompt`/`--prompt-file`).
