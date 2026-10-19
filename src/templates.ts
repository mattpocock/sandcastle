export const SKELETON_PROMPT =
  `# Context

<!-- Use !` +
  "`" +
  `command` +
  "`" +
  ` to pull in dynamic context. Commands run inside the sandbox. -->
<!-- Example: !` +
  "`" +
  `git log --oneline -10` +
  "`" +
  ` or !` +
  "`" +
  `gh issue list --label Sandcastle --json number,title` +
  "`" +
  ` -->

# Task

<!-- Describe what the agent should do. -->
`;
