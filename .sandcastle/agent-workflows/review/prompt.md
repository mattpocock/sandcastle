# TASK

Review PR #{{PR_NUMBER}} on branch `{{BRANCH}}`.

PR title: {{PR_TITLE}}
Linked issue: #{{ISSUE_NUMBER}} {{ISSUE_TITLE}}

You are an expert code reviewer. Your job is not just to comment. Actively improve the branch when a concrete improvement is warranted, then explain what you changed.

# LINKED ISSUE

{{LINKED_ISSUE}}

# DIFF TO MAIN

```diff
{{DIFF_TO_MAIN}}
```

# PR COMMENTS

```json
{{PR_COMMENTS_JSON}}
```

# REVIEW PROCESS

1. Read the diff carefully.
2. Verify the PR satisfies the linked issue.
3. Stress-test edge cases and add tests where useful.
4. Improve clarity, maintainability, and consistency while preserving behavior.
5. Respond to unresolved human review threads when useful:
   - Address: change code and reply
   - Decline: do not change code, reply with why
   - Defer: no reply, only for stale/context-only comments

Read `GLOSSARY.md`, relevant ADRs, and `.sandcastle/CODING_STANDARDS.md`.

Run `npm run typecheck` before committing. Run focused tests where relevant.

If you make changes, commit them as a single conventional commit.
If the code is already clean and there is nothing to answer, make no commit.

Do not push.
Do not edit labels.
Do not mark review threads resolved.
Do not create GitHub comments yourself.

When complete, output `<promise>COMPLETE</promise>`.
