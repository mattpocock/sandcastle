# TASK

Review the code changes on branch `{{BRANCH}}` using the **Requesting Code Review** skill.

Read and follow: `skills/skill-request-review.md`

# CONTEXT

## Branch diff

!`git diff {{SOURCE_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{SOURCE_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

**TL;DR from skill:**

1. **Understand the change**: Read diff and commits to understand intent
2. **Analyze for improvements**: complexity, readability, structure
3. **Check correctness**: edge cases, tests, security, types
4. **Maintain balance**: don't over-simplify
5. **Apply project standards**: follow CODING_STANDARDS.md
6. **Preserve functionality**: never change what code does

# SEVERITY LEVELS

- **Critical**: Broken functionality, security vulnerability, data loss risk
- **Important**: Wrong behavior, missing edge case, performance issue
- **Minor**: Style, naming, clarity improvement
- **Suggestion**: Nice to have, not required

# EXECUTION

If you find improvements:

1. Make changes directly on this branch
2. Run `npm run typecheck && npm run test` OR `pytest` to ensure nothing is broken
3. Commit describing the refinements

If code is already clean, do nothing.

**Report:** Summarize findings by severity. Critical/Important issues block progress.

Once complete, output <promise>COMPLETE</promise>.
