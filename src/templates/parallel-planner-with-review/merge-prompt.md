# MISSION

Integrate the following completed branches into the current branch and verify
the combined batch from immutable base `{{BATCH_BASE_SHA}}`:

{{BRANCHES}}

The batch—not each branch in isolation—is the unit of correctness. Preserve all
accepted behavior from every task and do not close any task until the cumulative
gate is green.

# REQUIRED CONTEXT

Before merging:

1. Read `.sandcastle/CODING_STANDARDS.md` completely.
2. Confirm `{{BATCH_BASE_SHA}}` names the current pre-merge integration commit.
3. Inspect the listed branches and associated tasks:

{{ISSUES}}

Read `.sandcastle/FEEDBACK_LOOPS.md` for integration ownership and
`.sandcastle/EVIDENCE_POLICY.md` before choosing checks, reusing proof or closing tasks.

# MERGE

Merge each listed branch with `git merge <branch> --no-edit`. Resolve conflicts
by reconstructing the contracts required by both tasks, their tests, and the
current integration branch. Do not discard one side wholesale. A temporarily
red state between branches is allowed because verification happens against the
complete batch.

If a branch cannot be safely merged, stop. Leave all tasks open, record the
exact conflict or blocker, and emit `<promise>BLOCKED</promise>`.

# CUMULATIVE INTEGRATION GATE

Commit resolutions or repairs before the final cumulative gate. Run the gate
once on the exact integrated source after the complete batch. If a later repair
invalidates evidence, diagnose narrowly and rerun the required gate at the new
source. Reuse a passing full gate only through existing workflow-validated proof
for the exact source, environment and gate; otherwise execute it. A branch
completion signal or agent-authored receipt alone is insufficient.

This default runner uses normal merger ownership. Delegating verification and
closure requires an explicitly approved staged-host workflow adapter; the policy
alone does not enable that adapter. Staged live acceptance remains open under
its authorized protocol.

After every listed branch has been merged:

1. List the complete change set with
   `git diff --name-only {{BATCH_BASE_SHA}}...HEAD`.
2. Map those paths to affected packages or modules using their manifests and
   build configuration.
3. Run every affected-package authoritative gate defined in
   `.sandcastle/CODING_STANDARDS.md`, from the package directory and with its
   declared package manager or build tool.
4. Run focused integration or contract tests for boundaries touched by more
   than one merged branch.
5. Run `git diff --check` and inspect the cumulative diff and repository status
   for secrets, local state, generated-file mistakes, and unrelated churn.

Fix failures in the integrated state and rerun the failing command plus the
affected cumulative gates. Never report an unexecuted command as passing. An
in-scope failure remains red; proven pre-existing or environmental failures
must be recorded explicitly and keep task closure blocked unless the project
standards explicitly permit them.

Keep the final tested source unchanged through closure. Do not create an empty
summary commit merely to mark the batch complete.

# CLOSE TASKS

Close tasks only after the cumulative gate is green. For each task above,
replace `<ID>` in this command with its task ID and run:

`{{CLOSE_TASK_COMMAND}}`

If any merge, repair, or required gate remains incomplete, leave every affected
task open and emit `<promise>BLOCKED</promise>`.

Otherwise summarize the merged branches and exact gates run, then emit:

<promise>COMPLETE</promise>
