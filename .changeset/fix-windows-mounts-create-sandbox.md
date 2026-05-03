---
"@ai-hero/sandcastle": patch
---

Fix `createSandbox` and `createSandboxFromWorktree` missing `patchGitMountsForWindows` call (ADR-0006). On Windows + Docker Desktop, the parent `.git` mount kept a `C:/...` `sandboxPath`, which the Linux daemon parsed on `:` and rejected with `invalid mode: /dev/.../.git`. The two `createSandbox` paths now mirror the wiring already present in `SandboxFactory.ts` (head + worktree).
