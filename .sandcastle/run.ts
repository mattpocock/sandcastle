import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

/** The JSON the planner writes inside its `<plan>` tag. */
const PlanSchema = z.object({
  issues: z.array(
    z.object({ number: z.number(), title: z.string(), branch: z.string() }),
  ),
});

const MAX_ITERATIONS = 10;
const MAX_PARALLEL = 4;

// True when `branch` has commits the current branch doesn't. The review and
// merge phases ask git rather than trusting this cycle's `commits`: a branch
// an earlier cycle advanced but never merged gets no new commits when its
// issue comes round again, so gating on `commits.length` would skip its
// review and strand it forever.
const isAheadOfHead = (branch: string): boolean => {
  try {
    const count = execFileSync(
      "git",
      ["rev-list", "--count", `HEAD..${branch}`],
      { encoding: "utf8" },
    );
    return Number(count.trim()) > 0;
  } catch (error) {
    console.warn(
      `  ⚠ couldn't compare ${branch} with HEAD: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
};

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Phase 1: Plan — orchestrator agent analyzes issues and picks parallelizable work
  const plan = await sandcastle.run({
    sandbox: docker(),
    name: "Planner",
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/plan-prompt.md",
  });

  const planJson = /<plan>(?<plan>[\s\S]*?)<\/plan>/u.exec(plan.stdout)
    ?.groups?.["plan"];
  if (planJson === undefined) {
    throw new Error(
      `Orchestrator did not produce a <plan> tag.\n\n${plan.stdout}`,
    );
  }

  const { issues } = PlanSchema.parse(JSON.parse(planJson));

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
  const acquire = async () =>
    running < MAX_PARALLEL
      ? (running++, Promise.resolve())
      : new Promise<void>((resolve) => {
          queue.push(resolve);
        });
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
          name: `Implementer #${issue.number}`,
          agent: sandcastle.claudeCode("claude-opus-4-8"),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            ISSUE_NUMBER: String(issue.number),
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        // Review whenever the branch has work the current branch lacks, not
        // only when this run committed. An earlier cycle may have committed
        // and then failed before or during its review; the merge phase picks
        // that branch up (see isAheadOfHead), so it must be reviewed here first.
        if (isAheadOfHead(issue.branch)) {
          await sandbox.run({
            name: `Reviewer #${issue.number}`,
            agent: sandcastle.claudeCode("claude-opus-4-8"),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              ISSUE_NUMBER: String(issue.number),
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

  // Merge every finished branch that is ahead of HEAD, whichever cycle made
  // its commits. Each one was reviewed in this cycle's Phase 2.
  const completedIssues = issues.filter(
    (issue, i) =>
      settled[i]?.status === "fulfilled" && isAheadOfHead(issue.branch),
  );

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) ahead of HEAD:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    console.log("No branches ahead of HEAD. Nothing to merge.");
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
