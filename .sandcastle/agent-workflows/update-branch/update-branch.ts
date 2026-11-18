import * as fs from "node:fs";
import * as path from "node:path";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { Output } from "@ai-hero/sandcastle/v1";
import {
  asRecord,
  asString,
  claudeAgent,
  fail,
  required,
  standardSchema,
  writeText,
} from "../shared/common";
import { renderPrompt } from "../shared/prompt";
import { runWithExtraction } from "../shared/run-with-extraction";
import {
  cloneRepo,
  fetchRef,
  installDependencies,
  headSha,
  openSandbox,
  pushBranch,
  quote,
  run,
  runTrimmed,
} from "../shared/sandbox";

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
const BRANCH_HEAD_SHA = required("BRANCH_HEAD_SHA");

const BASE = quote(`origin/${BASE_REF}`);

type MergeResult =
  | { status: "clean" }
  | { status: "conflict"; conflicts: string[] };

const unmergedFiles = async (sandbox: Sandbox): Promise<string[]> => {
  const listed = await run(sandbox, "git diff --name-only --diff-filter=U");
  return listed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

const tryMerge = async (sandbox: Sandbox): Promise<MergeResult> => {
  const merged = await sandbox.exec({
    command: `git merge ${BASE} --no-edit`,
    allowFailure: true,
  });
  console.log(merged.stdout);
  if (merged.exitCode === 0) {
    return { status: "clean" };
  }
  const conflicts = await unmergedFiles(sandbox);
  if (conflicts.length === 0) {
    console.error(merged.stderr);
    fail("git merge failed but no conflicts reported — aborting.");
  }
  return { status: "conflict", conflicts };
};

const push = async (sandbox: Sandbox): Promise<void> =>
  pushBranch(sandbox, {
    branch: BRANCH,
    leaseSha: BRANCH_HEAD_SHA,
    advanced: "Branch advanced during update-branch run.",
  });

try {
  await using sandbox = await openSandbox();
  await cloneRepo(sandbox, { branch: BRANCH });
  await installDependencies(sandbox);
  await fetchRef(sandbox, BASE_REF);

  const preMergeSha = await headSha(sandbox);
  const baseSha = await runTrimmed(sandbox, `git rev-parse ${BASE}`);

  const mergeBase = await runTrimmed(sandbox, `git merge-base HEAD ${BASE}`);
  if (mergeBase === baseSha) {
    writeText(
      "comment.md",
      `\`agent:update-branch\`: branch is already up to date with \`origin/${BASE_REF}\`. No merge needed.`,
    );
    console.log("Already up to date — nothing to do.");
    process.exit(0);
  }

  const mergeResult = await tryMerge(sandbox);

  if (mergeResult.status === "clean") {
    await push(sandbox);
    writeText(
      "comment.md",
      `\`agent:update-branch\`: merged \`origin/${BASE_REF}\` (\`${baseSha.slice(
        0,
        7,
      )}\`) into \`${BRANCH}\` cleanly — no conflicts.`,
    );
    console.log("Clean merge — pushed.");
    process.exit(0);
  }

  console.log(
    `Merge produced conflicts in ${mergeResult.conflicts.length} file(s) — invoking agent.`,
  );

  const result = await runWithExtraction({
    sandbox,
    name: `update-branch-pr-${PR_NUMBER}`,
    agent: claudeAgent(),
    prompt: await renderPrompt(
      path.join(import.meta.dirname, "prompt.md"),
      { PR_NUMBER, BRANCH, BASE_REF },
      {
        sandbox,
        // Its `gh pr view` line, run before the session, from the template.
        commandEnv: { GH_TOKEN: process.env.GH_TOKEN ?? "" },
      },
    ),
    output: Output.object({ tag: "output", schema: updateBranchOutputSchema }),
    extractionPrompt: fs.readFileSync(
      path.join(import.meta.dirname, "extraction.md"),
      "utf8",
    ),
  });

  const postSha = await headSha(sandbox);
  if (postSha === preMergeSha) {
    fail("Agent produced no commits — branch still at pre-merge HEAD.");
  }

  const unresolved = await unmergedFiles(sandbox);
  if (unresolved.length > 0) {
    fail(`Agent left unresolved conflicts in:\n${unresolved.join("\n")}`);
  }

  await push(sandbox);
  writeText("comment.md", result.output.comment);
  console.log(`Agent resolved conflicts. Pushed ${postSha}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
