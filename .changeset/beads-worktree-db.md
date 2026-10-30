---
"@ai-hero/sandcastle": patch
---

Fix the beads issue tracker in worktree sandboxes. `sandcastle init --issue-tracker beads` now scaffolds a `sandboxOptions` that every sandbox call receives: a mount of the host's `.beads/` and `BEADS_DIR` pointing at it, so merge-to-head and branch sandboxes share the host's beads database instead of failing with "no beads database found". The beads image now installs a pinned, checksum-verified bd release (`ARG BEADS_VERSION`, default 1.3.2) instead of the unpinned main-branch install script.
