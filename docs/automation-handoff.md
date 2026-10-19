# Kit-demo automation handoff: adoption and recovery inventory

Assessment date: 2026-10-03. Input: the working-tree handoff
`kit-demo/docs/reuse-handoff/04-sandcastle.md` and its referenced workflow,
readiness tracker/reviewer, execution audit, qualification lane and vendor record.
The handoff names baseline `8134f3d5cb13b155d2f70c816061595bb8347934`; the inspected
kit-demo checkout is `3312cce5479ca7d58e34130f00a107591b26c870`.
Sandcastle starts from `4ca3f8ddd60831d97e982c82f9dd1ca11134e0af`.
The changes described here are working-tree changes, not a released archive.

## Adopted behavior

The shared core now exposes `inspectGitHubReadinessBacklog` and
`admitGitHubReadinessBatch`. The reviewed template and generated Codex AFK
profile use them alongside the existing readiness verifier and Agent Map.

- Refresh the selected contracts before any issue worktree starts. A changed
  issue, hold, dependency, checkout or source commit rejects the batch.
- Fork new branches from the admitted source commit, and require the same clean
  integration baseline before merging. Check integrated branch ancestry on host.
- Recognize both COMPLETE and BLOCKED. Commits from a blocked implementation do
  not authorize review or merge. Reused branch commits need a completed
  implementation and fresh review; their existence alone is insufficient.
- Stop a batch that makes no verified progress. Diagnose the full scoped backlog
  when no batch is selected. Distinguish pending implementation from external
  qualification and metadata; qualification issues remain open.
- Verify the entire expected tracker snapshot after per-issue publication
  readbacks. Any concurrent edit keeps the stage failed with its partial journal.
- Share private atomic record persistence between readiness and checkpoint
  recovery; a new audit write does not truncate the last durable record.

No GitHub labels, issue bodies or dependency edges were changed to perform this
adoption. No real provider/qualification process is needed for its contract tests.

## Core and profile ownership

| Core interface or behavior                               | Project-owned input/policy                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Complete issue snapshot, pagination, dependency state    | Explicit repository, scope/state/hold labels and issue conventions         |
| Backlog diagnosis and fresh batch admission              | Product meaning of gates, acceptance and external prerequisites            |
| Source baseline, clean checkout and branch ancestry      | Merge strategy; squash/rebase needs explicit provenance policy             |
| Agent proposal structure and host verifier contract      | Requirement/evidence mapping and gate verifier                             |
| Label deltas, final snapshot verification and journal    | Whether publication is report-only or approved for apply                   |
| `withWorkflowRecovery` checkpoints and ownership         | Stable run/step identity, independent verification and reconciliation      |
| Init presets and sandbox/worktree orchestration          | Node/npm or Android/Gradle commands, Docker image, standards and model     |
| Inspection results exposing qualification kind/contracts | Allowlisted protocols, fixture identity, environment/resources and cleanup |

Core deliberately does not import EComposer/Shopify contracts, issue-number
registries, store domains or credentials. In kit-demo, the qualification program
registry and evidence/gate parsers contain project decisions. They remain profile
code. Creating a separate task or weakening an AC is not a core readiness action.

## Two consumer examples

The interface is the same for a Node service and an Android app; no product
module needs importing:

```ts
import {
  inspectGitHubReadinessBacklog,
  admitGitHubReadinessBatch,
  createSandbox,
} from "@ai-hero/sandcastle";

const nodeProfile = {
  cwd: process.cwd(),
  repository: "example/service-runtime",
  scopeLabel: "agent-work",
  readyLabel: "ready-for-agent",
  blockedLabel: "blocked",
  holdLabels: ["needs-decision"],
};
const androidProfile = {
  ...nodeProfile,
  repository: "example/mobile-app",
  scopeLabel: "mobile-work",
};

// Choose the actual profile and use its complete issue contracts in the planner.
const profile = androidProfile;
const planned = await inspectGitHubReadinessBacklog(profile);
const selected = await projectPlanner(planned.eligible); // project-owned
const admitted = await admitGitHubReadinessBatch(profile, {
  snapshot: planned.snapshot,
  branch: planned.branch,
  issues: selected,
});
for (const issue of admitted.issues) {
  const sandbox = await createSandbox({
    branch: `sandcastle/issue-${issue.number}`,
    baseBranch: admitted.head,
    sandbox: projectSandbox(profile), // project-owned provider/image/config
  });
  // The workflow owns implementation, review, gates and sandbox.close().
}
```

This is a contract example, not an executable qualification protocol. Existing
init tests exercise both Node/npm and Android/Gradle artifact generation. Core
and workflow tests use temporary Git checkouts and fake tracker/model executables.
They establish local portability at this interface, not live provider parity.

## Recovery evidence matrix

| Interruption or failure              | Current evidence                                                                                                       | Limit or remaining work                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Before implementation                | Generated-workflow stale-eligibility regression; admission tests reject changed contract/source/branch                 | Admission and process ownership are distinct; default template is not a checkpointed controller           |
| Between implement/review             | `WorkflowRecovery.test.ts` reuses independently verified implementation; workflow tests review retained branch commits | Repeated controller execution still starts the implementer; full phase resume needs stable workflow steps |
| Mid-implementation or live container | Uncertain-step reconciliation blocks blind re-execution                                                                | Container adoption and process identity/re-attachment are not implemented                                 |
| After merge/before readiness         | Generated-workflow tests verify merge then assess/unlock the next batch; host ancestry/checkout guards                 | A crash in this exact window is not covered by an automatically checkpointed generated workflow           |
| GitHub response lost                 | Recovery tests reconcile acknowledged closure without duplicate effect; readiness tests preserve partial publication   | Fresh snapshot/reassessment is required; no blind replay of an old proposal                               |
| Concurrent runner                    | Recovery tests reject another owner across linked checkouts and different run IDs                                      | Applies only to workflows explicitly wrapped in `withWorkflowRecovery`                                    |
| Host sleep/heartbeat loss            | Ownership uses a live PID/host check, never heartbeat age; SIGKILL test distinguishes a dead host process              | Dashboard interruption is not process-death proof; unknown child writers remain a reconciliation blocker  |
| Corrupt/unavailable journal          | Recovery tests fail before further execution; private atomic persistence is shared                                     | Local-filesystem semantics; storage/hardware guarantees remain environment-dependent                      |
| Empty/no-progress frontier           | Backlog includes reason codes/cycles; workflow tests stop no-progress and report qualification pending                 | Product evidence satisfaction remains the profile verifier's responsibility                               |
| Agent error/BLOCKED                  | Workflow tests retain open issues and exclude the branch from review/integration                                       | Partial successful batches may still integrate their completed branches                                   |

Recording/dashboard, retained Git history and a generic checkpoint primitive are
different capabilities. The generated template is not automatically crash-resumable
and does not adopt containers. Use [the recovery interface/runbook](workflow-recovery.md)
only with project-owned verification/reconciliation for every durable step.

## Durable records and reconciliation

Checkpoint schema version 1 is owned by `withWorkflowRecovery`:
`runId`, `workflowVersion`, `targetBranch`, overall `running|completed`, and
step records containing `key`, canonical JSON `input`, `running|verified` and
JSON result evidence. Steps flush before execution and after verification.
Ownership and journals live under the Git common directory, so linked worktrees
share the same target-branch lock. Each owner has a host/PID/token; an old heartbeat
never permits takeover. An uncertain step requires stopped former writers plus
an independently verified result. There is no automatic schema migration.

Readiness journals are separate: `mode`, trigger, branch, full snapshot,
assessment, verifier output, `applied`, optional `pending`, status and error.
Inspect `.git/sandcastle/readiness/` after a partial publication. Read current
HEAD/branch, tracker contracts/dependencies and the recorded per-issue outcome,
then run fresh assessment and trusted verification. Even when a readback failed,
the remote effect may already have occurred. Do not restore old labels blindly.

## Packaging and migration

Sandcastle's source package is MIT, currently version 0.12.0. This change adds no
new dependencies or consumer archives. Existing kit-demo vendor archives and its
readiness-role patch remain historical inputs; their shared npm version does
not identify the running build by itself.

To ship a reviewed fork build:

1. Commit the source changes; record the full runtime source SHA. Record any
   additional patch file and its SHA-256 separately.
2. Build/test from that source with its lockfile, then `npm pack --ignore-scripts`.
   Give the archive a distinct source-qualified filename.
3. Record package/license, source SHA, patches, archive SHA-256 and npm lock
   integrity. Retain historical archives unchanged for rollback. Inventory any
   redistributed third-party notices before publishing a bundled fork.
4. Update consumer package/archive and lockfile together, and verify the installed
   public interfaces. Compare generated `main` changes manually; init does not
   overwrite an existing project configuration.
5. Keep repository labels, gate verifier, Docker/commands, model/auth and
   qualification resource policies in the consumer profile. Pilot with a fake
   tracker first; live tracker publication needs explicit project configuration.

An old installed 0.12.0 archive will not gain these interfaces from editing a
consumer script alone. Review its actual source/digest and rebuild/re-pin first.
Rollback means restoring the prior archive and lock together, then reconciling
Git/tracker state. Package rollback does not undo already acknowledged effects.

## Verification — 2026-10-03

`npm run typecheck`, `npm run build` (including the Effect-free public-type check),
changed-file Prettier checks and `git diff --check` passed. The emitted SDK exports
both new interfaces alongside checkpoint recovery.

264 tests passed across `Readiness.test.ts`, `ReadinessWorkflow.test.ts`,
`WorkflowRecovery.test.ts`, `InitService.test.ts` and `InitService.agents.test.ts`.
The workflow cases use real orchestration/Git worktrees and external fake
tracker/model processes; the recovery suite includes a real runner SIGKILL.
This is a focused affected-suite result, not a claim about the full repository
suite, live Docker/providers, GitHub publication or qualification environments.

## Remaining delivery work

The next phase is a checkpointed generated controller with stable plan/batch
identity and per-stage verifiers, followed by live-container adoption with a
process/container identity contract. It needs fault injection in each exact
stage window, including host-sleep versus process death and mid-publication crash.
Qualification orchestration can then accept project-owned protocol/fixture/
environment adapters; it must not execute an argv supplied by issue/model text.
A production qualification lane, real Docker/provider crash pilot, release/push
policy and live tracker pilot have not been implemented or exercised by this change.
