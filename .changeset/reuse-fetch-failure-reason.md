---
"@ai-hero/sandcastle": patch
---

Say why a reused worktree was not refreshed from `origin`. When `git fetch origin <branch>` fails on reuse, the message now carries git's own error. A branch that is not on `origin` yet stays a plain log line; any other fetch failure (network, authentication, a bad remote), and a branch that has diverged from `origin`, is now a `console.warn` that says the run may build on a stale base. The worktree is still reused, so offline runs keep working.
