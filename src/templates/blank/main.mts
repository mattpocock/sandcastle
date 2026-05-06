import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

const sandboxConfig = {
  env: {
    GIT_CONFIG_GLOBAL: "/home/agent/workspace/.sandcastle/.gitconfig",
    /* {{SANDBOX_ENV_ENTRIES}} */
  },
  mounts: [
    /* {{SANDBOX_MOUNT_ENTRIES}} */
  ],
};

const hooks = {
  sandbox: {
    onSandboxReady: [
      /* {{CODEX_AUTH_READY_HOOK}} */
    ],
  },
};

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(sandboxConfig),
  hooks,
  promptFile: "./.sandcastle/prompt.md",
});
