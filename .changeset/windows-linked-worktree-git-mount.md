---
"@ai-hero/sandcastle": patch
---

Fix Docker on Windows failing with `too many colons` when the host repo is itself a linked git worktree (its `.git` is a file). Git mounts were resolved from the host repo's `.git`, so the host's own `.git` pointer file was mounted at its Windows path, which `patchGitMountsForWindows` never remaps. They are now resolved from the sandbox worktree's own `.git`, in `run()`, `createSandbox()`, `createWorktree()` and `interactive()` (#996).
