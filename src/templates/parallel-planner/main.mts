// Parallel Planner — three-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):    An opus agent analyzes open issues, builds a dependency
//                      graph, and outputs a <plan> JSON listing unblocked issues
//                      with their target branch names.
//   Phase 2 (Execute): N sonnet agents run in parallel via Promise.allSettled,
//                      each working a single issue on its own branch.
//   Phase 3 (Merge):   A sonnet agent merges every branch that is ahead of the
//                      current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import { spawn } from "node:child_process";
import { once } from "node:events";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// True when `branch` has commits the current branch doesn't. The merge phase
// asks git rather than trusting this cycle's `commits`: a branch an earlier
// cycle advanced but never merged gets no new commits when its issue comes
// round again, so gating on `commits.length` would strand it forever.
const isAheadOfHead = async (branch: string): Promise<boolean> => {
  const git = spawn("git", ["rev-list", "--count", `HEAD..${branch}`], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = once(git, "close");
  let count = "";
  for await (const chunk of git.stdout) {
    count += String(chunk);
  }
  await closed;
  return git.exitCode === 0 && Number(count.trim()) > 0;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Install hooks only for worktree phases (execute). Planner and merger
// bind-mount the real checkout (no branchStrategy), so an `npm install`
// there would rewrite the host's node_modules — e.g. Linux native binaries
// on macOS, or packages removed from the host tree.
const installHooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each execute
// sandbox starts. Avoids a full npm install from scratch; the hook above
// handles platform-specific binaries and any packages added since the last
// copy. Safe only with a worktree — never pair this with a head bind-mount.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    sandbox: docker(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    // Opus for planning: dependency analysis benefits from deeper reasoning.
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/plan-prompt.md",
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute
  //
  // Spawn one sonnet agent per issue, all running concurrently.
  // Each agent works on its own branch so there are no conflicts during
  // execution — merging happens in Phase 3.
  //
  // Promise.allSettled means one failing agent doesn't cancel the others.
  // -------------------------------------------------------------------------
  const settled = await Promise.allSettled(
    issues.map((issue) =>
      sandcastle.run({
        hooks: installHooks,
        copyToWorktree,
        // Each agent starts on its own branch via branchStrategy on run().
        sandbox: docker(),
        branchStrategy: { type: "branch", branch: issue.branch },
        name: "implementer",
        // Give each agent plenty of room to implement and iterate on tests.
        maxIterations: 100,
        // Sonnet for execution: fast and capable enough for typical issue work.
        agent: sandcastle.claudeCode("claude-sonnet-4-6"),
        promptFile: "./.sandcastle/implement-prompt.md",
        // Prompt arguments substitute {{TASK_ID}}, {{ISSUE_TITLE}},
        // and {{BRANCH}} placeholders in implement-prompt.md before the
        // agent sees the prompt.
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      }),
    ),
  );

  // Log any agents that threw (network error, sandbox crash, etc.), and
  // only pass branches that are ahead of the current branch to the merge
  // phase, whichever cycle made their commits (see isAheadOfHead).
  const finishedIssues: typeof issues = [];
  for (const [i, issue] of issues.entries()) {
    const outcome = settled[i];
    if (outcome?.status === "rejected") {
      console.error(
        `  ✗ ${issue.id} (${issue.branch}) failed: ${outcome.reason}`,
      );
    } else if (outcome?.status === "fulfilled") {
      finishedIssues.push(issue);
    }
  }
  const ahead = await Promise.all(
    finishedIssues.map(async (issue) => isAheadOfHead(issue.branch)),
  );
  const completedIssues = finishedIssues.filter((_, i) => ahead[i] === true);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) ahead of HEAD:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // No branch has work the current branch lacks — nothing to merge.
    console.log("No branches ahead of HEAD. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One sonnet agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything still works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    sandbox: docker(),
    name: "merger",
    maxIterations: 1,
    // Sonnet is sufficient for merge conflict resolution.
    agent: sandcastle.claudeCode("claude-sonnet-4-6"),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
