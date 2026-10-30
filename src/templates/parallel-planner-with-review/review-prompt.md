# MISSION

Review task {{TASK_ID}} — {{ISSUE_TITLE}} — on branch `{{BRANCH}}`. Verify the
implementation against the task contract and project standards, repair any
in-scope defect you find, and leave the branch at a verified commit. Do not
expand product scope or close the task.

Load the task exactly once using `{{VIEW_TASK_COMMAND}}`; replace `<ID>` with
`{{TASK_ID}}`. Read only parent-spec sections referenced by the task or needed
to interpret an acceptance criterion. Read
`@.sandcastle/CODING_STANDARDS.md` completely before judging the change.

Read `.sandcastle/FEEDBACK_LOOPS.md` for role-owned checks and
`.sandcastle/EVIDENCE_POLICY.md` before validating or reusing evidence.

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
code and tests when needed. The initial inventory and bounded commit list do not
limit review scope; inspect remaining commits as needed. For large generated or
encoded artifacts, verify producers, schema/hash/decoding scripts and actual
consumers/tests instead of dumping opaque payloads into model input. Record each
file's review method and result alongside the AC ledger. Missing coverage keeps
review incomplete; do not silently truncate data or waive an AC.

# EXPLORATION

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
   - Does the diff follow `@.sandcastle/CODING_STANDARDS.md`?
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
   `.sandcastle/FEEDBACK_LOOPS.md`; test coverage gaps and repairs independently.

At completion, verify all focused evidence under the evidence policy,
run `git diff --check`, and inspect the
final scoped diff and status. Never report an unexecuted command as passing.
An in-scope failure remains red; record proven pre-existing or environmental
failures explicitly.

# REVIEW ROUND

This is review round {{REVIEW_ROUND}}. Implementer repair rounds configured:
{{REVIEW_REPAIR_ROUNDS}}.

- When the configured repair rounds are above 0, do not repair code yourself.
  Report every in-scope defect as a finding; the implementer repairs the
  findings and you review again. On a later round, confirm each earlier
  finding is resolved and review the new changes.
- When the configured repair rounds are 0, repair in-scope defects yourself as
  described in this prompt.

# COMPLETION GATE

The branch is branch-ready for integration only when every branch-required
review row passes or is contract-justified `not-applicable`, no critical or
major finding remains, affected branch checks are green, and the diff contains no unrelated
churn, secrets, local state, generated-file mistakes, or undocumented contract
changes.

If repairs were required, commit them with DCO sign-off and a concise
`RALPH: <conventional type>(<scope>): <review outcome>` subject. If no repair is
needed, do not create an empty commit.

Record the integration owner's command and future gate as `pending-integration`
in the review ledger. Only that owner's future checks may be pending; missing
behavior evidence remains a finding. This signal means branch-ready, not
issue-complete, and does not authorize closure. Print the final review ledger,
then emit exactly one verdict as JSON inside the tag:

<review-verdict>{"verdict":"approve","summary":"One paragraph.","findings":[]}</review-verdict>

- `approve`: the branch is branch-ready; only `minor` findings may be listed.
- `changes-requested`: list every finding the implementer must repair, each as
  `{"id":"F1","severity":"critical|major|minor","file":"path","line":12,"change":"Required change"}`
  (`file` and `line` are optional; ids are unique).
- `blocked`: the review cannot be completed (missing contract, unavailable
  environment). Explain in `summary` and emit `<promise>BLOCKED</promise>`
  instead of the completion signal.

After an `approve` or `changes-requested` verdict, emit:

<promise>COMPLETE</promise>
