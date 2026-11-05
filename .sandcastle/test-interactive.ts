import * as sandcastle from "@ai-hero/sandcastle";

// /matt-pococks-projects/sandcastle
const { commits, branch } = await sandcastle.interactive({
  branchStrategy: {
    type: "merge-to-head",
  },
  name: "Test",
  agent: sandcastle.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  copyToWorktree: ["node_modules"],
});

console.log("Commits:", commits);
console.log("Branch:", branch);
