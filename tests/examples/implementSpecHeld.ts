import { createSandbox } from "@ai-hero/sandcastle/v1";
import { daytona } from "@ai-hero/sandcastle/v1/sandboxes/daytona";
import { implementSpec } from "@ai-hero/sandcastle/v1/tasks";

await using sandbox = await createSandbox({
  provider: daytona(),
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  timeLimitMinutes: implementSpec.limits.timeLimitMinutes,
});

const result = await implementSpec.run(sandbox, {
  repo: "acme/widgets",
  spec: "671",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  skillsContext: { tracker: { kind: "github" } },
  setup: ["npm ci"],
});

console.log(result.status, result.pr?.url, result.summary);
