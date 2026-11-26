import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { claudeCode, createSandbox } from "@ai-hero/sandcastle/v1";
import { bwrap } from "@ai-hero/sandcastle/v1/sandboxes/bwrap";

// Blank template: one sandbox and one agent session. Build your own workflow from here.
// Run this from your repo root with: npx tsx .sandcastle/main.mts

// Sandcastle reads no env file, so this file loads .sandcastle/.env itself.
// The sandbox gets exactly the env you pass it, and nothing else from this machine.
const envFile = parseEnv(await readFile(".sandcastle/.env", "utf8"));
const env = Object.fromEntries(
  Object.entries(envFile).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

await using sandbox = await createSandbox({
  provider: bwrap(),
  env,
  timeLimitMinutes: 60,
});

// The sandbox starts empty. Clone your repo into it first, for example:
// await sandbox.exec('git clone "https://x-access-token:$GH_TOKEN@github.com/you/repo.git" .');

/**
 * Drops the prompt's HTML comments, then runs each !`command` left in it
 * inside the sandbox and puts the command's output in its place.
 */
const expandShellExpressions = async (prompt: string): Promise<string> => {
  let expanded = prompt.replaceAll(/<!--[\s\S]*?-->/gu, "");
  for (const match of expanded.matchAll(/!`(?<command>[^`]+)`/gu)) {
    const { stdout } = await sandbox.exec(match.groups?.command ?? "");
    expanded = expanded.replace(match[0], () => stdout.trimEnd());
  }
  return expanded;
};

const result = await sandbox.session({
  agent: claudeCode("claude-opus-4-8"),
  prompt: await expandShellExpressions(
    await readFile(".sandcastle/prompt.md", "utf8"),
  ),
});

console.log(result.finalMessage);
