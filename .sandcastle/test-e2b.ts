import * as sandcastle from "@ai-hero/sandcastle";
import { e2b } from "@ai-hero/sandcastle/sandboxes/e2b";

const { commits, branch } = await sandcastle.run({
  sandbox: e2b({ template: "claude" }),
  name: "Test",
  agent: sandcastle.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  hooks: {
    sandbox: {
      onSandboxReady: [{ command: "npm install && npm run build" }],
    },
  },
});

console.log("Commits:", commits);
console.log("Branch:", branch);
