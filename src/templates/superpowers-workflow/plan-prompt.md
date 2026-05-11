# ISSUES

Here are the open issues in the repo:

<issues-json>

!`{{LIST_TASKS_COMMAND}}`

</issues-json>

The list above has already been filtered to issues ready for work.

# EXISTING WORKTREES

Check for existing worktrees in the sandcastle worktree folder. Run `git worktree list` to see all worktrees, then look for any that match the pattern `issue-{id}` or `sandcastle/issue-{id}` in the branch name.

If an existing worktree is found for an issue, use its branch name in the plan output instead of generating a new one.

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

For each unblocked issue, check if an existing worktree exists (from the EXISTING WORKTREES section above). If found, use that worktree's branch name. Otherwise, assign a new branch name using the format `sandcastle/issue-{id}-{slug}`.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42-fix-auth-bug"}]}
</plan>

IMPORTANT: Output raw JSON only. Do NOT escape quotes (no `\"`). Do NOT use JavaScript string literals or indentation escapes. The output must be valid JSON that can be parsed directly with `JSON.parse()`.

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).
