import * as dotenv from "dotenv";
dotenv.config({ path: ".sandcastle/.env" });

import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";

const { commits, branch } = await sandcastle.run({
  sandbox: podman(),
  name: "Test",
  agent: sandcastle.claudeCode(
    process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
  ),
  prompt: "Add /foobar to the .gitignore, then commit.",
  hooks: {
    sandbox: {
      onSandboxReady: [
        {
          command: "npm install && npm run build",
        },
      ],
    },
  },
});

console.log("Commits:", commits);
console.log("Branch:", branch);
