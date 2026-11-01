import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { claudeAgent, fail, required, writeJson } from "../shared/common";
import { runWithExtraction } from "../shared/run-with-extraction";
import { parseBatch, planSchema, renderIssues } from "./batch";

/**
 * Batch explore: ONE orchestrating agent reads every open `agent:explore`
 * issue, groups them by likely shared root cause, spawns its own subagents
 * to explore the groups, confirms membership, and produces one validated
 * plan. Read-only — writes `plan.json` to OUTPUT_DIR; `apply.ts` (in a
 * separate job) is the only thing that touches GitHub.
 */

const ISSUES_FILE = required("ISSUES_FILE");

/** One repair attempt on invalid structured output. */
const MAX_RETRIES = 1;

const promptPath = (file: string) => path.join(import.meta.dirname, file);

try {
  const batch = parseBatch(JSON.parse(await readFile(ISSUES_FILE, "utf8")));
  if (batch.length === 0) {
    fail("No open agent:explore issues in the batch file.");
  }

  console.log(
    `Batch: ${batch.length} issue(s): ${batch.map((i) => `#${i.number}`).join(", ")}`,
  );

  // The schema enforces the whole-batch rules, so an invalid plan earns one
  // repair attempt.
  const plan = await runWithExtraction({
    name: "explore-batch",
    agent: claudeAgent(),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: promptPath("prompt.md"),
    promptArgs: {
      ISSUE_COUNT: String(batch.length),
      ISSUES: renderIssues(batch),
    },
    output: sandcastle.Output.object({
      tag: "output",
      schema: planSchema(batch),
    }),
    extractionPrompt: await readFile(promptPath("extraction.md"), "utf8"),
    maxRetries: MAX_RETRIES,
  });

  writeJson("plan.json", plan.output);
  console.log(`Plan written for ${plan.output.issues.length} issue(s).`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
