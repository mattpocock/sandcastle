import * as dotenv from "dotenv";
dotenv.config({ path: ".sandcastle/.env" });

import * as sandcastle from "@ai-hero/sandcastle";
import { vercel } from "@ai-hero/sandcastle/sandboxes/vercel";

const claudeInstallHook = {
  command: "curl -fsSL https://claude.ai/install.sh | bash",
};

const ghCliInstallHook = {
  command:
    "curl -fsSL https://cli.github.com/packages/rpm/gh-cli.repo -o /etc/yum.repos.d/gh-cli.repo && dnf install -y gh",
  sudo: true,
};

// /matt-pococks-projects/sandcastle
const { commits, branch } = await sandcastle.run({
  sandbox: vercel({
    token: process.env.VERCEL_OIDC_TOKEN,
    teamId: "matt-pococks-projects",
    projectId: "sandcastle",
  }),
  name: "Test",
  agent: sandcastle.claudeCode(
    process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
  ),
  prompt: "Add /foobar to the .gitignore, then commit.",
  hooks: {
    sandbox: {
      onSandboxReady: [
        claudeInstallHook,
        ghCliInstallHook,
        {
          command: "npm install && npm run build",
        },
      ],
    },
  },
});

console.log("Commits:", commits);
console.log("Branch:", branch);
