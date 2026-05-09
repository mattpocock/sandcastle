import * as dotenv from "dotenv";
dotenv.config({ path: ".sandcastle/.env" });

import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

// /matt-pococks-projects/sandcastle
const { commits, branch } = await sandcastle.interactive({
  branchStrategy: {
    type: "merge-to-head",
  },
  name: "Test",
  agent: sandcastle.claudeCode(
    process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
  ),
  prompt: "Add /foobar to the .gitignore, then commit.",
  copyToWorkspace: ["node_modules"],
});

console.log("Commits:", commits);
console.log("Branch:", branch);
