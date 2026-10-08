# CANDIDATE INVENTORY

The configured task tracker returned the following open tasks:

<issues-json>

{{ISSUES_JSON}}

</issues-json>

Treat this as a candidate inventory, not proof of readiness. Tracker-side
filters may limit the inventory, but every candidate still needs the eligibility
and parallel-safety checks below. Do not run another broad list query.

# ELIGIBILITY

Build a dependency graph from task bodies, labels, comments, explicit
dependency metadata, and requirements. A task is eligible only when all of
these are true:

1. It is an implementation ticket with concrete, executable acceptance
   criteria. Parent specs, PRDs, epics, tracking tasks, and meta tasks are never
   implementation candidates.
2. Every explicit blocker or dependency is resolved. Recognize tracker-native
   dependency fields and sections such as `Blocked by` or `Depends on`. When a
   candidate includes `blockers` and `explicitBlockersResolved`, those states
   were resolved before planning: `false` means blocked and `true` means there
   is no unresolved explicit dependency. Otherwise, if a referenced task's
   state is absent, inspect only that task with `{{VIEW_TASK_COMMAND}}`,
   replacing `<ID>` with its ID.
3. It has no inferred dependency on another open task whose code, migration,
   public contract, infrastructure, or unresolved decision it requires.
4. Its acceptance criteria can be completed without an unresolved product or
   public-interface decision.

Do not confuse merge overlap with dependency. Two independently eligible tasks
may still be unsafe to execute in the same batch.

# PARALLEL BATCH

From the eligible tasks, select a maximal mutually parallel-safe batch. Do not
combine tasks whose likely implementations overlap enough in files, migrations,
schemas, shared interfaces, generated artifacts, or ownership to create a
material merge or integration risk.

Related domain language is not sufficient evidence of a conflict. Predict
concrete repository paths or module roots for every candidate. README files,
documentation, environment examples, and package-manager lockfiles alone are
incidental overlap and must not prevent parallel execution.

When eligible tasks conflict with each other, deterministically select one and
defer the others to a later planning cycle. Prefer explicit tracker priority;
when priority is absent or tied, prefer the lowest numeric task ID, then lexical
ID. Deferral due to batch overlap does not make a task blocked.

For each selected task, assign the exact branch name
`sandcastle/issue-{id}`—no slug or suffix. This deterministic name preserves
accumulated progress when the same task is planned again.

# OUTPUT

Return one decision for every candidate in the inventory. Allowed dispositions
are `selected`, `blocked`, `not-implementation`, `unresolved-decision`, and
`parallel-conflict`. Every decision needs a concise reason and concrete
`likelyAreas`. A `parallel-conflict` must list selected issue IDs in
`conflictsWith`; their material `likelyAreas` must overlap.

The previous attempt's validation result is:

<plan-feedback>
{{PLAN_FEEDBACK}}
</plan-feedback>

Output only the selected batch and complete decision ledger as JSON wrapped in
`<plan>` tags:

<plan>
{"issues":[{"id":"42","title":"Fix auth bug","branch":"sandcastle/issue-42"}],"decisions":[{"id":"42","disposition":"selected","reason":"Independent implementation slice","likelyAreas":["apps/api"]},{"id":"43","disposition":"parallel-conflict","reason":"Both change the same API contract","likelyAreas":["packages/contracts"],"conflictsWith":["42"]}]}
</plan>

If no task is eligible, return an empty `issues` array. Never select an
ineligible or blocked task, parent spec, PRD, epic, tracking task, or meta task
as a fallback. Always emit the tags, including for the empty plan:

<plan>{"issues":[],"decisions":[...]}</plan>
