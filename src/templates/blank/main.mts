import * as dotenv from "dotenv";
dotenv.config({ path: ".sandcastle/.env" });

import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

await run({
  agent: claudeCode(process.env.ANTHROPIC_MODEL || "claude-opus-4-6"),
  sandbox: docker(),
  promptFile: "./.sandcastle/prompt.md",
});
