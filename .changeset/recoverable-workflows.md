---
"@ai-hero/sandcastle": minor
---

Add opt-in `withWorkflowRecovery` for durable, independently verified workflow
checkpoints and exclusive target-branch ownership across linked worktrees.
Require reconciliation of uncertain attempts, preserve ownership while parallel
steps settle, and reject stale contracts/evidence. Keep recovery separate from
agent-session resume and dashboard recordings; live sandbox adoption is not
included. Report stale dashboard heartbeats as unknown and make Git/GitHub and
verification commands asynchronous in readiness and reviewed/Codex AFK scaffolds.
