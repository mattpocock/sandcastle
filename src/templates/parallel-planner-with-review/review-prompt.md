# MISSION

Review task {{TASK_ID}} — {{ISSUE_TITLE}} — on branch `{{BRANCH}}`. Verify the
implementation against the task contract and project standards, repair any
in-scope defect you find, and leave the branch at a verified commit. Do not
expand product scope or close the task.

Load the task exactly once using `{{VIEW_TASK_COMMAND}}`; replace `<ID>` with
`{{TASK_ID}}`. Read only parent-spec sections referenced by the task or needed
to interpret an acceptance criterion. Read
`@.sandcastle/CODING_STANDARDS.md` completely before judging the change.

# CONTEXT

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# EXPLORATION

Inspect the changed public interfaces, their callers, affected tests, package
manifests, and relevant identity, persistence, compatibility, and security
invariants. Use repository code and executable behavior as evidence.

# REVIEW LEDGER

Map every acceptance criterion and explicitly named scenario to:

`ID | requirement | implementation evidence | test evidence | status`

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
4. Run one authoritative gate from
   `@.sandcastle/CODING_STANDARDS.md` for every affected package.

At completion, run all focused evidence, `git diff --check`, and inspect the
final scoped diff and status. Never report an unexecuted command as passing.
An in-scope failure remains red; record proven pre-existing or environmental
failures explicitly.

# COMPLETION GATE

Complete only when every review-ledger row passes, all in-scope findings are
repaired, affected-package gates are green, and the diff contains no unrelated
churn, secrets, local state, generated-file mistakes, or undocumented contract
changes.

If repairs were required, commit them with DCO sign-off and a concise
`RALPH: <conventional type>(<scope>): <review outcome>` subject. If no repair is
needed, do not create an empty commit.

Print the final review ledger, then emit:

<promise>COMPLETE</promise>
