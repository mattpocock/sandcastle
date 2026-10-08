// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFile } from "node:child_process";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
// @ts-expect-error scaffold copies the shared helper beside main.mts.
import { validatePlannerBatch } from "./planner-batch.js";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const decisionSchema = z.object({
  id: z.string(),
  disposition: z.enum([
    "selected",
    "blocked",
    "not-implementation",
    "unresolved-decision",
    "parallel-conflict",
  ]),
  reason: z.string().min(1),
  likelyAreas: z.array(z.string()),
  conflictsWith: z.array(z.string()).optional(),
});

const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
  decisions: z.array(decisionSchema),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;
const MAX_PLANNER_ATTEMPTS = 3;

// Host commands must not block recording heartbeats or other pipeline callbacks.
function runHost(
  file: string,
  args: string[],
  options: { input?: string; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: options.timeout ?? 90_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on("error", () => {}); // A failed child is reported by the callback.
    child.stdin?.end(options.input);
  });
}

// Set an explicit fork repository and stable scope label before enabling.
// Null repository leaves existing tracker workflows unchanged (no GitHub calls).
const readiness = z
  .object({
    mode: z.enum(["disabled", "report-only", "apply"]),
    repository: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .nullable(),
    scopeLabel: z.string().min(1),
    readyLabel: z.string().min(1),
    blockedLabel: z.string().min(1),
    holdLabels: z.array(z.string().min(1)),
    verifyCommand: z.array(z.string().min(1)).min(1).nullable(),
  })
  .strict()
  .parse(JSON.parse(readFileSync(".sandcastle/readiness.json", "utf8")));
const readinessEnabled =
  readiness.mode !== "disabled" && readiness.repository !== null;
const trackerEnvironment: Record<string, string> = readinessEnabled
  ? { GH_REPO: readiness.repository! }
  : {};
// Host prompt commands and every execution sandbox must target the same fork.
if (readinessEnabled) process.env.GH_REPO = readiness.repository!;
const readinessEnvironment = {
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  GH_ENTERPRISE_TOKEN: "",
  GITHUB_ENTERPRISE_TOKEN: "",
  GH_CONFIG_DIR: "/tmp/readiness-gh",
};

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// The host records the map independently of the optional dashboard process.
// In a second terminal: npx sandcastle dashboard
const agentMap = await sandcastle.createAgentMap({
  cwd: process.cwd(),
  name: "Parallel planner with review",
});

const loadPlannerInventory = async (): Promise<unknown[]> =>
  readinessEnabled
    ? sandcastle.loadGitHubReadinessInventory({
        ...readiness,
        repository: readiness.repository!,
        cwd: process.cwd(),
      })
    : (JSON.parse(
        await runHost("bash", [".sandcastle/planner-inventory.sh"]),
      ) as unknown[]);

const currentBranch = async () =>
  (await runHost("git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

async function reassess(batch: number, trigger: sandcastle.ReadinessTrigger) {
  if (!readinessEnabled) return;
  await agentMap.track(
    {
      batch,
      role: "readiness",
      title: `Readiness / ${trigger.kind} / ${readiness.mode}`,
      branch: await currentBranch(),
    },
    async (logging) => {
      const result = await sandcastle.reassessGitHubReadiness({
        ...readiness,
        mode: readiness.mode === "apply" ? "apply" : "report-only",
        repository: readiness.repository!,
        cwd: process.cwd(),
        trigger,
        verify: readiness.verifyCommand
          ? async (input) =>
              JSON.parse(
                await runHost(
                  readiness.verifyCommand![0]!,
                  readiness.verifyCommand!.slice(1),
                  {
                    input: JSON.stringify(input),
                    timeout: 300_000,
                  },
                ),
              )
          : undefined,
        assess: async (snapshot) => {
          // Fresh worktree, no bootstrap hooks, no tracker credentials.
          const branch = `sandcastle/readiness-${randomUUID()}`;
          const sandbox = await sandcastle.createSandbox({
            branch,
            sandbox: docker({ env: readinessEnvironment }),
            copyToWorktree: [],
          });
          try {
            const run = await sandbox.run({
              logging,
              name: "readiness",
              maxIterations: 1,
              agent: sandcastle.claudeCode("claude-opus-4-8"),
              promptFile: "./.sandcastle/readiness-prompt.md",
              promptArgs: {
                READINESS_INPUT: JSON.stringify({ snapshot, trigger }),
              },
              completionSignal: [
                "<promise>COMPLETE</promise>",
                "<promise>BLOCKED</promise>",
              ],
            });
            const status = await sandbox.exec(
              "git status --porcelain --untracked-files=all",
            );
            if (
              run.completionSignal !== "<promise>COMPLETE</promise>" ||
              run.commits.length ||
              status.exitCode !== 0 ||
              status.stdout.trim()
            ) {
              throw new Error(
                "Readiness assessment incomplete or modified its checkout; refusing publication",
              );
            }
            const blocks = [
              ...run.stdout.matchAll(/<readiness>([\s\S]*?)<\/readiness>/g),
            ];
            if (blocks.length !== 1)
              throw new Error("Expected exactly one readiness result");
            return JSON.parse(
              blocks[0]![1]!.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
            );
          } finally {
            await sandbox.close();
          }
        },
      });
      console.log(
        `Readiness ${result.mode}: ${result.applied.length} issue(s) changed. Audit: ${result.auditPath}`,
      );
      if (logging.type === "file")
        logging.onAgentStreamEvent?.({
          type: "text",
          message: JSON.stringify({
            mode: result.mode,
            decisions: result.assessment.decisions,
            applied: result.applied,
            auditPath: result.auditPath,
          }),
          timestamp: new Date(),
          iteration: 1,
        });
      return { completionSignal: "<promise>COMPLETE</promise>", commits: [] };
    },
  );
}

async function planNextBatch(batch: number) {
  const inventory = await loadPlannerInventory();
  let feedback = "No previous validation failure.";

  for (let attempt = 1; attempt <= MAX_PLANNER_ATTEMPTS; attempt++) {
    let validationFailed = false;
    try {
      const result = await agentMap.track(
        {
          batch,
          role: "planner",
          title: `Plan attempt ${attempt}`,
          branch: await currentBranch(),
        },
        async (logging) => {
          const result = await sandcastle.run({
            logging,
            hooks,
            sandbox: docker({ env: trackerEnvironment }),
            name: `planner-${attempt}`,
            maxIterations: 1,
            agent: sandcastle.claudeCode("claude-opus-4-8"),
            promptFile: "./.sandcastle/plan-prompt.md",
            promptArgs: {
              ISSUES_JSON: JSON.stringify(inventory),
              PLAN_FEEDBACK: feedback,
            },
            output: sandcastle.Output.object({
              tag: "plan",
              schema: planSchema,
            }),
          });

          try {
            validatePlannerBatch(inventory, result.output);
          } catch (error) {
            validationFailed = true;
            throw error;
          }
          return result;
        },
      );
      return result.output;
    } catch (error) {
      // Observe execution errors, but only retry invalid plans as before.
      if (!validationFailed) throw error;
      feedback = error instanceof Error ? error.message : String(error);
      console.warn(`Planner attempt ${attempt} rejected: ${feedback}`);
    }
  }

  throw new Error(`Planner failed validation: ${feedback}`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function executeWorkflow() {
  await reassess(1, { kind: "startup" });
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
    const plan = await planNextBatch(iteration);
    await agentMap.recordPlan(iteration, plan);
    const issues = plan.issues;

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
    // Phase 2: Execute + Review
    //
    // For each issue, create a sandbox via createSandbox() so the implementer
    // and reviewer share the same sandbox instance per branch. The implementer
    // runs first; if it produces commits, the reviewer runs in the same sandbox.
    //
    // Promise.allSettled means one failing pipeline doesn't cancel the others.
    // -------------------------------------------------------------------------

    const settled = await Promise.allSettled(
      issues.map(async (issue) => {
        let sandbox: sandcastle.Sandbox | undefined;
        try {
          // Include sandbox setup in the observed implementer phase.
          const implement = await agentMap.track(
            {
              batch: iteration,
              role: "implementer",
              issueId: issue.id,
              title: issue.title,
              branch: issue.branch,
            },
            async (logging) => {
              sandbox = await sandcastle.createSandbox({
                branch: issue.branch,
                sandbox: docker({ env: trackerEnvironment }),
                hooks,
                copyToWorktree,
              });

              return sandbox.run({
                logging,
                name: "implementer",
                maxIterations: 100,
                agent: sandcastle.claudeCode("claude-sonnet-4-6"),
                promptFile: "./.sandcastle/implement-prompt.md",
                promptArgs: {
                  TASK_ID: issue.id,
                  ISSUE_TITLE: issue.title,
                  BRANCH: issue.branch,
                },
              });
            },
          );

          // Only review if the implementer produced commits
          if (sandbox && implement.commits.length > 0) {
            const review = await agentMap.track(
              {
                batch: iteration,
                role: "reviewer",
                issueId: issue.id,
                title: issue.title,
                branch: issue.branch,
              },
              (logging) =>
                sandbox!.run({
                  logging,
                  name: "reviewer",
                  maxIterations: 1,
                  agent: sandcastle.claudeCode("claude-sonnet-4-6"),
                  promptFile: "./.sandcastle/review-prompt.md",
                  promptArgs: {
                    TASK_ID: issue.id,
                    ISSUE_TITLE: issue.title,
                    BRANCH: issue.branch,
                  },
                }),
            );

            // Merge commits from both runs so the merge phase sees all of them.
            // Each sandbox.run() only returns commits from its own run.
            return {
              ...review,
              commits: [...implement.commits, ...review.commits],
            };
          }

          return implement;
        } finally {
          await sandbox?.close();
        }
      }),
    );

    // Log any agents that threw (network error, sandbox crash, etc.).
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        console.error(
          `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
        );
      }
    }

    // Only pass branches that actually produced commits to the merge phase.
    // An agent that ran successfully but made no commits has nothing to merge.
    const completedIssues = settled
      .map((outcome, i) => ({ outcome, issue: issues[i]! }))
      .filter(
        (entry) =>
          entry.outcome.status === "fulfilled" &&
          entry.outcome.value.commits.length > 0 &&
          entry.outcome.value.completionSignal ===
            "<promise>COMPLETE</promise>",
      )
      .map((entry) => entry.issue);

    const completedBranches = completedIssues.map((i) => i.branch);

    console.log(
      `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
    );
    for (const branch of completedBranches) {
      console.log(`  ${branch}`);
    }

    if (completedBranches.length === 0) {
      // All agents ran but none made commits — nothing to merge this cycle.
      console.log("No commits produced. Nothing to merge.");
      await agentMap.finishBatch(iteration);
      continue;
    }

    // Immutable baseline for validating the entire integrated batch. Capturing
    // this before the merger starts prevents per-branch checks from missing
    // incompatibilities that only appear after multiple branches are combined.
    const batchBaseSha = (await runHost("git", ["rev-parse", "HEAD"])).trim();

    // -------------------------------------------------------------------------
    // Phase 3: Merge
    //
    // One agent merges all completed branches into the current branch,
    // resolving any conflicts and running tests to confirm everything works.
    //
    // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
    // uses to know which branches to merge and which issues to close.
    // -------------------------------------------------------------------------
    const merge = await agentMap.track(
      {
        batch: iteration,
        role: "merger",
        title: "Integrate batch",
        branch: await currentBranch(),
      },
      (logging) =>
        sandcastle.run({
          logging,
          hooks,
          sandbox: docker({ env: trackerEnvironment }),
          name: "merger",
          maxIterations: 1,
          agent: sandcastle.claudeCode("claude-sonnet-4-6"),
          promptFile: "./.sandcastle/merge-prompt.md",
          promptArgs: {
            // A markdown list of branch names, one per line.
            BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
            // A markdown list of issue IDs and titles, one per line.
            ISSUES: completedIssues
              .map((i) => `- ${i.id}: ${i.title}`)
              .join("\n"),
            // The integration commit before any branch in this batch is merged.
            BATCH_BASE_SHA: batchBaseSha,
          },
        }),
    );

    if (merge.completionSignal !== "<promise>COMPLETE</promise>") {
      throw new Error(
        "Merge did not complete; readiness and the next planner are stopped",
      );
    }
    await reassess(iteration, {
      kind: "post-merge",
      base: batchBaseSha,
      branches: completedBranches,
      issues: completedIssues.map((issue) => Number(issue.id)),
      completionSignal: merge.completionSignal,
    });
    await agentMap.finishBatch(iteration);

    console.log("\nBranches merged.");
  }

  console.log("\nAll done.");
}

try {
  await executeWorkflow();
  await agentMap.finish("completed");
} catch (error) {
  await agentMap.finish("failed");
  throw error;
}
