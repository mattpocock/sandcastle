import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  asRecord,
  asString,
  claudeAgent,
  fail,
  required,
  sh,
  standardSchema,
  writeText,
} from "../shared/common";
import { runWithExtraction } from "../shared/run-with-extraction";

interface UpdateBranchOutput {
  readonly comment: string;
}

const updateBranchOutputSchema = standardSchema<UpdateBranchOutput>((value) => {
  const record = asRecord(value, "update-branch output");
  return { comment: asString(record.comment, "comment") };
});

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");
const BASE_REF = required("BASE_REF");

type MergeResult =
  | { status: "clean" }
  | { status: "conflict"; conflicts: string[] };

const tryMerge = (): MergeResult => {
  try {
    execFileSync("git", ["merge", `origin/${BASE_REF}`, "--no-edit"], {
      stdio: "inherit",
    });
    return { status: "clean" };
  } catch {
    const conflicts = sh("git diff --name-only --diff-filter=U")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (conflicts.length === 0) {
      fail("git merge failed but no conflicts reported — aborting.");
    }
    return { status: "conflict", conflicts };
  }
};

try {
  execFileSync("git", ["fetch", "origin", BASE_REF], { stdio: "inherit" });

  const preMergeSha = sh("git rev-parse HEAD").trim();
  const baseSha = sh(`git rev-parse origin/${BASE_REF}`).trim();

  const mergeBase = sh(`git merge-base HEAD origin/${BASE_REF}`).trim();
  if (mergeBase === baseSha) {
    writeText(
      "comment.md",
      `\`agent:update-branch\`: branch is already up to date with \`origin/${BASE_REF}\`. No merge needed.`,
    );
    writeText("should_push.txt", "false");
    console.log("Already up to date — nothing to do.");
    process.exit(0);
  }

  const mergeResult = tryMerge();

  if (mergeResult.status === "clean") {
    writeText(
      "comment.md",
      `\`agent:update-branch\`: merged \`origin/${BASE_REF}\` (\`${baseSha.slice(
        0,
        7,
      )}\`) into \`${BRANCH}\` cleanly — no conflicts.`,
    );
    writeText("should_push.txt", "true");
    console.log("Clean merge — wrapper will push.");
    process.exit(0);
  }

  console.log(
    `Merge produced conflicts in ${mergeResult.conflicts.length} file(s) — invoking agent.`,
  );

  const result = await runWithExtraction({
    name: `update-branch-pr-${PR_NUMBER}`,
    agent: claudeAgent(),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      PR_NUMBER,
      BRANCH,
      BASE_REF,
    },
    output: sandcastle.Output.object({
      tag: "output",
      schema: updateBranchOutputSchema,
    }),
    extractionPrompt: fs.readFileSync(
      path.join(import.meta.dirname, "extraction.md"),
      "utf8",
    ),
  });

  const postSha = sh("git rev-parse HEAD").trim();
  if (postSha === preMergeSha) {
    fail("Agent produced no commits — branch still at pre-merge HEAD.");
  }

  const unresolved = sh("git diff --name-only --diff-filter=U").trim();
  if (unresolved) {
    fail(`Agent left unresolved conflicts in:\n${unresolved}`);
  }

  writeText("comment.md", result.output.comment);
  writeText("should_push.txt", "true");
  console.log(`Agent resolved conflicts. Wrapper will push ${postSha}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
