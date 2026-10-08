import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const execFile = promisify(execFileCb);

const MAX_ITERATIONS = 10;
const MAX_PARALLEL = 4;

// True if `branch` has commits not yet on `main`. We ask git directly rather
// than relying on the implementer's `commits.length` from this iteration —
// a branch may already be ahead from a previous iteration whose merger
// never picked it up, in which case the next iteration's implementer finds
// the fix already in place, produces zero new commits, and (without this
// check) the branch silently drops out of the merger's input forever.
async function branchIsAheadOfMain(branch: string): Promise<boolean> {
  try {
    const { stdout } = await execFile("git", [
      "rev-list",
      "--count",
      `main..${branch}`,
    ]);
    return parseInt(stdout.trim(), 10) > 0;
  } catch (err) {
    console.warn(`  ⚠ couldn't check ${branch} ahead-of-main: ${err}`);
    return false;
  }
}

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Phase 1: Plan — orchestrator agent analyzes issues and picks parallelizable work
  const plan = await sandcastle.run({
    sandbox: docker(),
    name: "Planner",
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/plan-prompt.md",
  });

  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(
      "Orchestrator did not produce a <plan> tag.\n\n" + plan.stdout,
    );
  }

  const { issues } = JSON.parse(planMatch[1]) as {
    issues: { number: number; title: string; branch: string }[];
  };

  if (issues.length === 0) {
    console.log("No issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  #${issue.number}: ${issue.title} → ${issue.branch}`);
  }

  // Phase 2: Execute + Review — implement then review each branch, max 4 in parallel
  let running = 0;
  const queue: (() => void)[] = [];
  const acquire = () =>
    running < MAX_PARALLEL
      ? (running++, Promise.resolve())
      : new Promise<void>((resolve) => queue.push(resolve));
  const release = () => {
    running--;
    const next = queue.shift();
    if (next) {
      running++;
      next();
    }
  };

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      await acquire();
      try {
        await using sandbox = await sandcastle.createSandbox({
          sandbox: docker(),
          branch: issue.branch,
          copyToWorktree: ["node_modules"],
          hooks: {
            sandbox: {
              onSandboxReady: [{ command: "npm install && npm run build" }],
            },
          },
        });

        const result = await sandbox.run({
          name: "Implementer #" + issue.number,
          agent: sandcastle.claudeCode("claude-opus-4-8"),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: String(issue.number),
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        if (result.commits.length > 0) {
          await sandbox.run({
            name: "Reviewer #" + issue.number,
            agent: sandcastle.claudeCode("claude-opus-4-8"),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              TASK_ID: String(issue.number),
              ISSUE_TITLE: issue.title,
              BRANCH: issue.branch,
            },
          });
        }

        return result;
      } finally {
        release();
      }
    }),
  );

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ #${issues[i].number} (${issues[i].branch}) failed: ${outcome.reason}`,
      );
    }
  }

  const fulfilledIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i] }))
    .filter((entry) => entry.outcome.status === "fulfilled")
    .map((entry) => entry.issue);

  const aheadFlags = await Promise.all(
    fulfilledIssues.map((issue) => branchIsAheadOfMain(issue.branch)),
  );
  const completedIssues = fulfilledIssues.filter((_, i) => aheadFlags[i]);
  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) ahead of main:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    console.log("No branches ahead of main. Nothing to merge.");
    continue;
  }

  // Phase 3: Merge — one agent merges all branches together
  await sandcastle.run({
    sandbox: docker(),
    name: "Merger",
    maxIterations: 10,
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      ISSUES: completedIssues
        .map((i) => `- #${i.number}: ${i.title}`)
        .join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
