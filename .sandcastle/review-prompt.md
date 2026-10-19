# MISSION

Review task {{TASK_ID}} — {{ISSUE_TITLE}} — on branch `{{BRANCH}}`. Verify the
implementation against the task contract and project standards, repair any
in-scope defect you find, and leave the branch at a verified commit. Do not
expand product scope or close the task.

Load the task using `gh issue view <ID> --json number,title,body,labels,comments`; replace `<ID>` with
`{{TASK_ID}}`. Read only parent-spec sections referenced by the task or needed
to interpret an acceptance criterion. Read
`/home/agent/CODING_STANDARDS.md` completely before judging the change.
Read `/home/agent/FEEDBACK_LOOPS.md` completely before selecting or running
any executable feedback command.

A failed tracker request does not count as a successful contract read. Retry
transient failures or use the equivalent read-only GitHub REST endpoint. Never
substitute an incomplete local backlog for the issue's full body/comments.

Read `/home/agent/FEEDBACK_LOOPS.md` for role-owned checks and
`/home/agent/EVIDENCE_POLICY.md` before validating or reusing evidence.

# CONTEXT

## Task change inventory (navigation, not review evidence)

Immutable review baseline: `{{REVIEW_BASE_SHA}}`.

!`git diff --stat {{REVIEW_BASE_SHA}}...{{BRANCH}}`

!`git diff --name-status {{REVIEW_BASE_SHA}}...{{BRANCH}}`

## Commits on this branch

!`git log -n 20 {{REVIEW_BASE_SHA}}..{{BRANCH}} --oneline`

Review every changed file and every acceptance criterion. Read the full task
diff per file or small group with `git diff {{REVIEW_BASE_SHA}}...{{BRANCH}} -- <paths>`;
paginate unusually large diffs without losing coverage. Read callers, surrounding
code and tests when needed. Inventory and the bounded commit list do not limit
scope. For large generated/encoded artifacts, verify their producer, schema,
hash/decoding scripts and actual consumers/tests instead of dumping opaque
payloads into model input. Record each file's review method/result beside the
AC ledger. Missing coverage keeps review incomplete; do not silently truncate
data or waive an acceptance criterion.

# EXPLORATION

## CODEGRAPH NAVIGATION

Use the synchronized branch-local index before broad text searches:

```bash
codegraph explore "{{ISSUE_TITLE}}"
codegraph query "<relevant symbol>"
codegraph impact "<public symbol being changed>"
```

Use `codegraph node` for caller/callee context and `codegraph affected`
to select focused tests. Fall back to `rg` and direct file reads for exact
wire text, configuration, and graph misses. CodeGraph is navigation evidence, not correctness evidence;
tests and executable feedback gates establish correctness.

Inspect the changed public interfaces, their callers, affected tests, package
manifests, and relevant identity, persistence, compatibility, and security
invariants. Use repository code and executable behavior as evidence.

# REVIEW LEDGER

Map every acceptance criterion and explicitly named scenario to:

`ID | requirement | implementation evidence | test evidence | receipt/applicability | owner | status`

A criterion is not satisfied merely because a nearby test passes. Check the
observable public seam named by the task, or the narrowest existing public seam
when none is named. Record missing, weak, or implementation-coupled evidence as
a finding to repair.

# REVIEW PROCESS

Review along both axes:

1. **Specification and correctness**
   - Does every acceptance criterion work end to end, including named edge
     cases and failure paths?
   - Do tests assert independently known outcomes through public interfaces?
   - Are compatibility, persistence, idempotency, concurrency, and security
     contracts preserved where applicable?
   - Are errors observable without leaking secrets or sensitive local state?
2. **Standards and maintainability**
   - Does the diff follow `/home/agent/CODING_STANDARDS.md`?
   - Is the design as simple as the behavior permits, with clear ownership and
     no unnecessary abstraction, duplication, nesting, or unchecked casts?
   - Are comments, names, documentation, configuration, and generated files
     accurate and consistent?

Prioritize functional, security, data-loss, and compatibility defects over
style. Preserve verified behavior. Do not perform unrelated cleanup.

# REPAIR AND FEEDBACK LOOP

For each finding:

1. Add or strengthen focused regression evidence at the public seam when
   behavior is missing or incorrect.
2. Run the narrowest command and confirm it fails for the finding when a
   meaningful red state is possible.
3. Make the smallest in-scope repair and rerun that command to green.
4. Verify receipt applicability and run affected branch checks from
   `/home/agent/FEEDBACK_LOOPS.md`; test coverage gaps and repairs independently.

At completion, verify all focused evidence under the evidence policy,
run `git diff --check`, and inspect the
final scoped diff and status. Never report an unexecuted command as passing.
An in-scope failure remains red; record proven pre-existing or environmental
failures explicitly.

# COMPLETION GATE

The branch is branch-ready for integration only when every branch-required
review row passes or is contract-justified `not-applicable`, all in-scope findings
are repaired, affected branch checks are green, and the diff contains no unrelated
churn, secrets, local state, generated-file mistakes, or undocumented contract
changes.

If repairs were required, commit them with DCO sign-off and a concise
`RALPH: <conventional type>(<scope>): <review outcome>` subject. If no repair is
needed, do not create an empty commit.

Record the integration owner's command and future gate as `pending-integration`
in the review ledger. Only that owner's future checks may be pending; missing
behavior evidence remains a finding. This signal means branch-ready, not
issue-complete, and does not authorize closure. Print the final review ledger,
then emit:

<promise>COMPLETE</promise>
