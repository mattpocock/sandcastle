import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  promptFile: "./.sandcastle/prompt.md",
});
