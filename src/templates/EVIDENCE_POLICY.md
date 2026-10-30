# Minimum sufficient evidence

Before running checks, mark each requirement in the existing ledger as needing
new evidence or covered by an applicable existing receipt. Record the receipt
path/hash, tested source, environment, covered contract and reason for reuse.
Keep the original result and timestamps; a reused receipt is not a new test run.
Identify the environment with relevant image/toolchain, configuration, services,
migrations and test/harness versions. Unknown applicability means new evidence.

Reuse a passing full gate only through the workflow's existing validated proof
mechanism for the exact tested source, environment and gate. Otherwise run the
required gate. A completion signal, an agent-authored file/hash or a green result
on another branch is not validated full-gate proof. A proof-only descendant
commit is acceptable only if the workflow explicitly validates that relationship.
Changes to contracts, consumers, configuration or the interpreting harness
invalidate affected receipts. A private harness or documentation change calls
for its affected checks; it does not alone justify rerunning an unchanged
product gate or exempt behavior changed by that work.

Required checks follow the role table in FEEDBACK_LOOPS.md: focused
implementation and review evidence first, one cumulative gate owned by normal
merger or an explicitly approved staged host on the integrated source. Record
that future gate as `pending-integration` in branch ledgers, with its command
and owner. This is not a passing receipt or an acceptance waiver. Every branch
behavior/scenario needs passing evidence or a contract-justified
`not-applicable`; only the integration owner's future checks may be pending.
`<promise>COMPLETE</promise>` from implementer/reviewer means branch-ready,
not issue-complete. Full-gate failures remain visible and block closure.
Independent readiness/security checks remain required unless their trusted
verifier supports valid proof reuse; this policy does not bypass that verifier.

For an authorized live qualification protocol, test shared lifecycle/fault
behavior once. Reuse it across components only after checking shared
producer/consumer contracts and relevant code are equivalent. Record the
applicability and limits separately from each component's native evidence.
Every required environment/component cell still needs its own native behavior,
semantics, lifecycle and owned cleanup evidence. Run the full semantic suite at
the protocol's required phase; later revision checks observe what changed
unless the acceptance explicitly requires another full suite. An implementation
gate is not live acceptance. Staging or leaving a live criterion open requires
explicit workflow authority, not an agent's unilateral decision.

Refresh current authority, entitlement and required preflight under their
validity rules. Preserve actual browser/network/storage observations separately
from expected facts and labelled validation-only projections. After an
interruption, reconcile unsettled effects before retrying non-idempotent work
and release only proved-owned leases. Retain completed valid phases rather than
replaying the whole invocation. This is a reconciliation rule, not a claim that
the runner supports crash-resume or adoption of surviving containers. Move to
the next independent in-scope cell/task only after cleanup is verified.
A changed contract, invalid receipt or explicit acceptance requirement
determines what must rerun; missing evidence remains incomplete.
