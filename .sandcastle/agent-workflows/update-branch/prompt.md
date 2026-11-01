# TASK

PR #{{PR_NUMBER}} (branch `{{BRANCH}}`) has merge conflicts against its base `{{BASE_REF}}`. A `git merge origin/{{BASE_REF}} --no-edit` has already been attempted and left the working tree in a conflicted state. Your job is to resolve every conflict, finish the merge, and write a PR comment describing what you did.

# CONTEXT

Read `GLOSSARY.md` and any relevant ADRs under `docs/adr/` before resolving anything substantive.

<pr-view>

!`gh pr view {{PR_NUMBER}}`

</pr-view>

<merge-status>

!`git status`

</merge-status>

<conflicting-files>

!`git diff --name-only --diff-filter=U`

</conflicting-files>

# RESOLUTION POLICY

Always resolve. Do not abort the merge. Do not leave the branch in a half-finished state.

For each conflicting hunk:

1. **Investigate intent on both sides** before choosing a resolution. Use `git log -p --follow -- <path>` on both `origin/{{BASE_REF}}` and `{{BRANCH}}` to see how each side reached this state. Read the commit messages. If a commit references an issue, pull it with `gh issue view <n>`.
2. **Pick the resolution that preserves both intents** wherever possible. Where the intents are incompatible, pick the one that best matches the PR's stated goal (in `<pr-view>` above) and note the trade-off in your comment.
3. **Do not invent new behaviour.** Your job is reconciliation, not feature work. If a sensible resolution requires writing new logic that wasn't on either side, that's a signal to flag uncertainty rather than to be creative.

After resolving, run whatever checks you think are warranted — `npm run typecheck` is fast and catches most resolution mistakes; `npm run test` if you want stronger confidence. You decide. If something is broken, fix what you can; if you can't, push what you have and flag it clearly in the comment.

# COMMIT

Stage everything and finish the merge with a single commit. Conventional-commit style, e.g. `chore: merge origin/{{BASE_REF}} into {{BRANCH}}`. The wrapper will push whatever you commit.
