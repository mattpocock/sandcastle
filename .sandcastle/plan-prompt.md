# ISSUES

Here are the open issues in the repo:

<issues-json>

!`node src/templates/github-planner-inventory.cjs --label ready-for-agent`

</issues-json>

# TASK

Analyze the open issues and build a dependency graph. Each issue includes a
`blockers` array whose GitHub states were resolved before this prompt and an
`explicitBlockersResolved` boolean. `false` means the issue is blocked; `true`
means it has no unresolved explicit dependency. Do not re-query those states.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

For each unblocked issue, assign a branch name using the exact format `sandcastle/issue-{number}` (no slug or other suffix). This must be deterministic so that re-planning the same issue always produces the same branch name and accumulated progress is preserved.

If the issue appears to be a PRD and it has implementation issues which link to it, the PRD cannot be worked on.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"number": 42, "title": "Fix auth bug", "branch": "sandcastle/issue-42"}]}
</plan>

Include only unblocked issues. If every issue is blocked, return an empty
`issues` array. Never select a blocked issue merely to keep the loop running.
