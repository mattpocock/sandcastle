# Feedback Loops

This file is generated from `.sandcastle/project.json`. Commands are executed
inside the sandbox from the repository root. Update the project profile and
regenerate these artifacts when the package layout or build system changes.

## Bootstrap

- Command: `npm ci`
- Cache: `.sandcastle/cache/npm` → `/home/agent/.npm`

## Root Package

- Working directory: `.`
- Focused test: `npm test -- <affected-test-files> --run`

## Branch checks

- `npm run typecheck`
- `npm run build`

Run these checks and focused tests for every affected SDK/CLI/template contract.
Browser changes require focused HTTP/browser evidence. Reuse applicable receipts
under EVIDENCE_POLICY.md; dependencies cached on disk are not test receipts.

## Authoritative full gates (integration owner)

- `npm run typecheck`
- `npm test`
- `npm run build`
- `node --test scripts/agent-map.browser.test.mjs` (after build)

Run package gates in Linux, with writable ignored runtime log directories.
The initial host/macOS full suite has Podman Machine and physical-path fixture
failures; these are not permission to skip Linux tests or new regressions.
For operator web changes, add and run focused browser/HTTP tests for the issue's
criteria in addition to the existing Agent Map browser suite.

## Cumulative Merge Gate

Run `.sandcastle/scripts/verify-affected.sh <batch-base-sha>`. It validates
the complete diff from the immutable batch base before tasks may be closed.

## Verification by role

Read EVIDENCE_POLICY.md before choosing checks, reusing evidence or recovering
an interrupted qualification. Preserve every acceptance criterion and named
scenario; the role split changes gate ownership, not acceptance scope.

| Role                 | Required evidence                                                                                                                                           | Completion                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Implementer          | Focused public-contract tests for all changed behavior, relevant integration/browser/migration checks, affected lint/type/build checks and diff inspection. | Verified committed branch ready for review; cumulative gate `pending-integration`. |
| Reviewer             | Independently inspect every changed file and criterion, validate receipt applicability, test coverage gaps/repairs and run affected branch checks.          | Reviewed branch ready for integration; cumulative gate `pending-integration`.      |
| Normal merger        | One cumulative full gate on the exact integrated source after all batch branches and repairs, plus checks invalidated by integration.                       | Close only listed tasks whose required acceptance is verified.                     |
| Approved staged host | Only when the workflow explicitly delegates integration: run the isolated cumulative gate on the exact integrated source or validate existing proof.        | Own integration proof and authorized closure; staged live criteria remain open.    |

Select the smallest test set covering all changed contracts and named scenarios.
Shared module/schema/API changes include affected callers and compatibility;
justify the selected coverage. Full suites, verify-package and verify-affected
belong to the integration owner, unless an explicit acceptance criterion or
mandatory verifier requires earlier execution. Focused functional/security
failures block branch-ready; any known full-gate failure blocks task closure.
Record its command, source and symptom for the integration owner rather than
claiming a pass or concealing it.

Run the cumulative gate once on the final integrated candidate. If a repair
changes tested source or invalidates evidence, run affected diagnosis checks
then rerun the required gate at the new source. Reuse only validated proof under
EVIDENCE_POLICY.md. An approved staged host does not duplicate a normal merger's
valid gate; approval must specify who owns verification and task closure.
Independent readiness checks retain their verifier's requirements.

## Bounded diagnosis

Record the phase (implementation or authorized live qualification), in-scope
acceptance and retained external gates before investigating. For each attempt,
record source, command, duration, sanitized symptom, hypothesis/change, result
and next action in the existing ledger or ignored runtime artifacts.

Classify product, harness, environment or expectation failures only with
evidence; unproven classifications remain hypotheses. After two attempts with
the same symptom and no new evidence, or 20 minutes without new evidence,
change strategy to a smaller reproduction or instrumentation. These are
strategy thresholds, not automatic BLOCKED, acceptance waivers or permission
requests. Use a repository-local diagnosis skill if present; otherwise follow
this loop without depending on a host-only skill.

Repeat a command only with a stated prediction or a bounded transient retry.
Reconcile uncertain non-idempotent effects before retrying. After fixing the
cause, rerun the original reproduction and relevant regressions, remove temporary
instrumentation and select remaining gates by role. A harness repair preserves
the public contract and independently known expected facts; reassess receipts
that depended on the repaired harness. Record the established cause or exact
external blocker. Continue independent in-scope work only after owned cleanup
is verified; never report an unexecuted command as passing.

## Self-host readiness verification

The normal merger owns the cumulative implementation gate and task closure.
Self-host apply-mode readiness independently runs the Linux package/browser gate
at startup and after merge. Its trusted verifier currently has no reusable
full-gate receipt mechanism, so this independent check remains mandatory.
An agent's receipt or completion signal cannot replace it. The staged-host row
does not enable a staged workflow in this adapter.
