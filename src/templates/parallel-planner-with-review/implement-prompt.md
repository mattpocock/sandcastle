# MISSION

Complete task {{TASK_ID}} — {{ISSUE_TITLE}} — on branch `{{BRANCH}}`.
Work autonomously to a verified commit. The task is the scope boundary; the
repository and its existing public contracts are the source of implementation
truth. Resolve questions from those sources before treating them as blockers.

Load the task exactly once at the start using `{{VIEW_TASK_COMMAND}}`. Replace
`<ID>` in that command with `{{TASK_ID}}`. If the task references a parent spec
or PRD, read only the sections it names plus sections strictly necessary to
interpret an acceptance criterion. Work on this task only. Preserve unrelated
working-tree changes and accumulated branch progress. Do not close the task;
the verified merge phase owns closure.

# REQUIRED CONTEXT

Before editing:

1. Read `@.sandcastle/CODING_STANDARDS.md` completely.
2. Inspect `git status`, the last ten commits, relevant package manifests,
   public interfaces, and existing tests.

# EXPLORATION

Exploration is complete only when the current behavior, required behavior,
public observation seam, narrow red-capable command, affected packages, and
applicable identity, persistence, and security invariants are known for every
acceptance criterion. Use `rg` and direct file reads to establish exact
contracts and behavior.

# REQUIREMENT LEDGER

Before production edits, create and maintain this matrix:

`ID | source | requirement | public seam | exact test | command | status`

Include every acceptance criterion and every explicitly named scenario or edge
case. Include parent-spec requirements only when referenced by the task or
required to interpret one of its criteria. Never substitute one representative
example for an explicit list.

The acceptance criteria pre-authorize their named public seams for this AFK
run. When a criterion does not name a seam, use the narrowest existing public
boundary that observes the behavior: HTTP, CLI, hook, SDK contract, exported
module API, storage port, executable script, or user-visible artifact. Prefer
an existing seam over creating a new one. A materially unresolved product or
public-interface decision is a blocker; a question answerable from the task,
standards, tests, or code is not.

Every row must name executable evidence. Use `not-applicable` only when no
meaningful executable behavior exists, and record the contract-based reason.
An unmapped or unverified row keeps completion red regardless of suite status.

# EXECUTION — TRACER-BULLET TDD

Implement one observable vertical slice at a time. Each slice should satisfy
one ledger row across every required layer instead of building horizontal
layers in bulk.

For each changed behavior:

1. **RED** — add one focused behavior test at the public seam. Run it and
   confirm it fails for the expected missing behavior, not setup noise.
2. **GREEN** — implement only the end-to-end behavior required to pass that
   test. Run the same command until green.
3. **INTEGRATE** — run the nearest type, build, contract, or boundary check for
   the layers touched by the slice.
4. **RECORD** — update the ledger with the exact test name, command, and result.
5. **REPEAT** — choose the next still-red row and learn from the previous slice.

Keep tests specification-shaped and refactor-resistant. Assert independently
known outcomes through public interfaces. Avoid private-helper tests,
implementation-coupled mocks, database side-channel assertions when a public
read exists, tautological expectations, and writing all tests before any
implementation.

For docs, configuration, migrations, shell, or pure compatibility work, use
the closest red-capable executable evidence: contract test, validator, CLI
invocation, migration round-trip, shell smoke test, or link/example check. Do
not invent a meaningless unit test merely to claim RED. For behavior-preserving
refactors, establish characterization evidence before changing structure.

The implementation phase ends with green behavior. Leave discretionary
cleanup to the dedicated reviewer; perform only refactoring required by the
task or standards, and keep the focused loop green while doing it.

# FEEDBACK LOOPS

After each slice, run the narrowest red-capable command. At completion, run:

- every focused test recorded in the ledger;
- one authoritative gate from `@.sandcastle/CODING_STANDARDS.md` for each
  affected package;
- `git diff --check` and a final scoped diff/status inspection.

Run commands from the affected package and respect its package manager and
lockfile. Reuse available caches. Install dependencies only when the required
package executable is absent. Do not repeatedly run unchanged repository-wide
suites. Diagnose failures at their cause; never report an unexecuted command as
passing. Record environment-dependent skips and proven pre-existing failures
explicitly—an in-scope failure remains red.

# COMPLETION GATE

The task is complete only when all of the following are true:

- every ledger row is `pass` or justified `not-applicable`;
- changed behavior has focused regression evidence at an approved public seam;
- focused checks and every affected-package authoritative gate are green;
- the final diff is task-scoped and contains no unrelated churn, secrets,
  local state, generated-file mistakes, or undocumented compatibility change;
- localized user-facing documentation agrees across supported languages when
  applicable;
- all completed work is committed on `{{BRANCH}}`.

Commit once the gate is green. Use DCO sign-off and this subject shape:

```text
RALPH: <conventional type>(<scope>): <completed outcome>
```

Keep the body concise: reference task {{TASK_ID}} and its parent spec when
applicable, then record key decisions, material files or areas changed, and
notes needed by review or merge.

If genuinely blocked, leave the task open and add one concise tracker comment
with completed investigation, the exact blocker, and the failing command and
output summary. Do not create a completion commit. Then emit:

<promise>BLOCKED</promise>

Immediately before completion, print the final requirement ledger. Then emit:

<promise>COMPLETE</promise>
