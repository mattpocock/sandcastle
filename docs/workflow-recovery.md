# Workflow checkpoint recovery

`withWorkflowRecovery` is an opt-in host SDK interface. It does not automatically
make an existing script resumable, attach to an old sandbox, or change project
readiness rules. Native agent session resume is a separate feature.

## Interface

Wrap the whole workflow once; give each durable step a stable key, JSON input
contract, result schema and independent verifier. Put every external side effect
inside a step. The callback's control flow executes again on restart.

```typescript
import { withWorkflowRecovery } from "@ai-hero/sandcastle";
import { z } from "zod";

// These are project-owned functions, not built-in Sandcastle guarantees.
import {
  implement,
  review,
  verifyImplementation,
  verifyReview,
} from "./project-gates.js";

await withWorkflowRecovery(
  {
    cwd: process.cwd(),
    targetBranch: "main",
    runId: "delivery-2026-09-30", // reuse this exact value on restart
    workflowVersion: "delivery-v1",
  },
  async (workflow) => {
    const implemented = await workflow.step({
      key: "batch-1/implement/20",
      input: { issue: 20, contractDigest: "pinned-issue-and-prompt-digest" },
      schema: z.object({ sha: z.string(), gateDigest: z.string() }),
      execute: () => implement(20),
      verify: verifyImplementation,
    });
    await workflow.step({
      key: "batch-1/review/20",
      input: implemented,
      schema: z.object({ reviewedSha: z.string(), gateDigest: z.string() }),
      execute: () => review(implemented.sha),
      verify: verifyReview,
    });
  },
);
```

Results must be plain JSON evidence (commit SHAs, gate versions, tracker facts),
not sandbox handles, callbacks, undefined, dates or secrets. Input keys are
canonicalized; meaningful input changes stop recovery. Update the workflow
version when changing its semantics; old versions are not silently migrated.
Each step key must be unique within an invocation. Nested workflows targeting
the same branch are not supported. Parallel independent steps are supported.

## What a verifier must prove

A completion marker, issue closure, or an existing commit alone is not enough.
The core requires `verify(result) === true` both after execution and on replay;
the workflow owns the truth of that check. It must be read-only and use current
external evidence, not just return the value stored in the checkpoint.

- Implementation/review: exact source SHA, current branch or appropriate Git
  ancestry, relevant issue/prompt contract, and valid gate evidence for that SHA.
- Merge: intended source SHAs are integrated into the intended target and the
  cumulative integration gate applies to that integrated commit. Squash/rebase
  workflows need their own provenance check; ordinary ancestry is insufficient.
- Issue closure: explicit repository + issue number, current closure reason,
  linked integration evidence and current contract. Do not infer integration
  from `closed` alone.
- Readiness: re-read current issue/dependency/hold state and verify the desired
  label delta using the project's policy. No universal label promotion rule is
  built into recovery.

Plan once in a checkpoint and replay that recorded batch before asking for the
next plan. Do not regenerate a different plan under the same step keys. Record
merge, issue closure and readiness separately so their partial outcomes can be
reconciled independently. All recorded steps must be revisited before completion.
Repeated verification must account for legitimate downstream changes (for
example a reviewed SHA merged later), not merely require HEAD to stay unchanged.

## Crash windows and reconciliation

The journal records `running` and flushes it before `execute`. A verified result
is flushed before the step resolves. Exceptions do not imply that an external
write failed: an API may have committed before its response was lost.

On restart a `running` step is uncertain. It is never automatically executed
again. The workflow may supply a read-only `reconcile` callback:

```typescript
reconcile: async () => {
  const observed = await inspectPriorAttempt(); // project-owned
  if (!observed.formerWritersStopped || !observed.complete) return null;
  return { quiescent: true, result: observed.evidence };
};
```

The ordinary result schema and verifier still run after reconciliation. Setting
`quiescent: true` is a trusted assertion that former writers are stopped; it is
not proof obtained by the core. A live container, uncertain remote request, or
missing evidence must return `null`. New steps cannot start until all uncertain
attempts from the prior invocation have been reconciled. This first version has
no automatic retry/reset/abandon override for an incomplete attempt.

Ownership is retained until every step already started by the callback settles,
even if another parallel step fails or the callback forgets to await a step.
A hanging step therefore keeps ownership; timeouts/cancellation belong to its
executor. Do not resolve an executor while it still has active writers.

## Ownership and persistence

State lives under the canonical Git common directory:
`sandcastle/recovery/<target-branch-hash>/`. Linked worktrees share it; separate
clones and different host machines do not. Use one host and local filesystem;
this is not a distributed lease system or an NFS locking guarantee.

- One cooperative runner owns a repository/target branch, regardless of run ID.
- A live or inaccessible PID, or a different recorded hostname, blocks takeover.
  Only a confirmed missing PID on the same host permits recovering ownership.
  PID reuse conservatively blocks recovery; heartbeat age never authorizes it.
- An unfinished run blocks replacement run IDs. Resume the original run instead.
- A short exclusive `ownership-claim` file serializes ownership transitions.
  A crash inside this critical section leaves a deliberate fail-closed barrier.
  After inspecting and stopping **all** competing runners and old agents, an
  operator must resolve that exact claim; do not delete the journal or automatically
  expire the file. There is intentionally no force-unlock command in this version.
- Records are validated, privately permissioned, written to a temporary file,
  flushed and atomically renamed. Directory entries are also flushed on POSIX.
  The guarantee depends on the filesystem honoring these operations; network
  filesystems and power-loss behavior on other platforms are not certified.
- A storage failure prevents further checkpoint-authorized execution. Dashboard
  recording remains best-effort and is not the recovery source of truth.

This lock is cooperative, not an OS restriction on Git/GitHub credentials.
Scripts bypassing the wrapper and surviving sandbox agents are not fenced by
it. Keep important publication operations in controlled workflow steps, and do
not claim a lost runner's agent is dead just because its host PID disappeared.

## Rollout and verification

Existing `.sandcastle/main.*` files are not rewritten automatically. Adopt the
wrapper and project verifiers deliberately, then start a new recorded workflow.
Pre-existing Agent Map JSON cannot reconstruct missing recovery checkpoints.

Reviewed/Codex AFK scaffolds now run host inventory, Git and readiness verifier
commands asynchronously. Existing generated projects need the corresponding
script update. Dashboard heartbeat loss now reports `unknown`; it does not
trigger execution recovery.

Run `npx vitest run src/WorkflowRecovery.test.ts src/AgentMap.test.ts
src/Readiness.test.ts src/ReadinessWorkflow.test.ts src/InitService.test.ts` and
`npm run typecheck`. The tests use disposable Git repositories, a deliberately
terminated fixture runner, fake GitHub transport and fake agents; no production
issues, labels or containers are touched.
