# SUPERPOWERS WORKFLOW FOR ISSUE {{TASK_ID}}: {{ISSUE_TITLE}}

You are executing the full Superpowers workflow for issue {{TASK_ID}}: {{ISSUE_TITLE}}.

Read and follow each step below IN ORDER. Do not skip steps.

---

## Step 1: WRITING-PLANS

Read and follow: `skills/skill-writing-plans.md`

**TL;DR:**

1. Scope check: Does this issue need a plan? (simple fixes don't)
2. Create plan document: `docs/superpowers/plans/issue-{{TASK_ID}}-plan.md`
3. Break work into bite-sized tasks (2-5 minutes each)
4. Each task has: exact file paths, complete code, verification steps
5. NO placeholders - every task is complete with code
6. Self-review: spec coverage, placeholder scan, type consistency
7. Save plan and offer execution choice (Subagent-Driven recommended)

**Plan structure:**

```
# Implementation Plan: {{ISSUE_TITLE}}

## Overview
<brief description>

## Tasks
### Task 1: <title>
- **Files:** <exact paths>
- **Code:** <complete code>
- **Verify:** <specific commands>
```

---

## Step 2: SUBAGENT-DRIVEN DEVELOPMENT

Read and follow: `skills/skill-subagent-dev.md`

1. Read plan, extract ALL tasks with full text
2. Create TodoWrite with all tasks
3. For EACH task:
   a. Dispatch implementer subagent (Agent tool with full task text + context)
   b. Answer any questions from implementer
   c. Dispatch spec reviewer subagent (verify code matches spec)
   d. If spec issues: implementer fixes, re-review
   e. Dispatch code quality reviewer subagent
   f. If quality issues: implementer fixes, re-review
   g. Mark task complete in TodoWrite

---

## Step 3: TEST-DRIVEN DEVELOPMENT (during implementation)

Read and follow: `skills/skill-tdd.md`

**The Iron Law:** Write test FIRST, watch it fail, write minimal code, watch it pass.

**Red-Green-Refactor cycle:**

1. **RED:** Write failing test for one behavior
2. **Verify RED:** Run test, watch it fail
3. **GREEN:** Write minimal code to make test pass
4. **Verify GREEN:** Run test, watch it pass
5. **REFACTOR:** Clean up code (keep tests green)
6. **Repeat:** Next test

**Never:**

- Write implementation before test
- Skip RED verification
- Write more code than needed to pass test
- Delete tests after passing

**Python projects:** Use `pytest` for RED/GREEN/REFACTOR cycles.

---

## Step 4: REQUESTING CODE REVIEW (between tasks)

Read and follow: `skills/skill-request-review.md`

**When to review:**

- After EACH task in subagent-driven development
- Before moving to next task
- Critical issues BLOCK progress

**How to request:**

1. Dispatch code reviewer subagent (Agent tool)
2. Provide: branch diff, commits, plan context
3. Reviewer reports issues by severity (Critical/Important/Minor/Suggestion)
4. Fix Critical and Important issues before proceeding

---

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXECUTION

1. **Skill 1** (writing-plans) - create detailed plan
2. **Skill 2** (subagent-driven-development) - execute with subagents
3. **Skill 3** (TDD) - used by subagents during implementation
4. **Skill 4** (requesting-code-review) - review between tasks

# THE ISSUE

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `{{VIEW_TASK_COMMAND}}`. If it has a parent PRD, pull that in too.

Only work on the issue specified. Work on branch {{BRANCH}}.

# FINAL RULES

- Follow skills IN ORDER - do not skip
- Use TodoWrite to track tasks
- Commit after each task completion
- Run `npm run typecheck && npm run test` OR `pytest` before committing (depending on project)
- Commit message: `RALPH:` prefix + task completed + key decisions
- Do not close the issue - this will be done later
- Output `<promise>COMPLETE</promise>` when skills 1-4 executed

**ONLY WORK ON A SINGLE ISSUE.**
