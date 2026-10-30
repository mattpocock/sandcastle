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
// Implementer repair rounds after a changes-requested review; 0 = single-pass review.
const MAX_REPAIR_ROUNDS = 2;
// Extra attempts for provider/infrastructure failures of one issue pipeline.
const TASK_RETRIES = 1;
// Stop starting pipelines after this many consecutive provider failures.
const PROVIDER_FAILURE_THRESHOLD = 3;
const breaker = sandcastle.createCircuitBreaker(PROVIDER_FAILURE_THRESHOLD);
// "batch": one merger integrates the whole batch after every pipeline settles.
// "per-branch": each approved branch is integrated as soon as it is approved.
const MERGE_MODE: "batch" | "per-branch" = "batch";
// Post-merge readiness is incremental; every Nth post-merge run is full.
const READINESS_FULL_EVERY = 5;
let postMergeAssessments = 0;

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
    qualificationLabel: z.string().min(1).default("ready-for-qualification"),
    publishBody: z.boolean().default(false),
    contextIssueNumbers: z.array(z.number().int().positive()).optional(),
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
  const incremental =
    trigger.kind === "post-merge" &&
    ++postMergeAssessments % READINESS_FULL_EVERY !== 0;
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
        incremental,
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
  const backlog = readinessEnabled
    ? await sandcastle.inspectGitHubReadinessBacklog({
        ...readiness,
        repository: readiness.repository!,
        cwd: process.cwd(),
      })
    : undefined;
  const head =
    backlog?.snapshot.head ??
    (await runHost("git", ["rev-parse", "HEAD"])).trim();
  const branch = backlog?.branch ?? (await currentBranch());
  const inventory = backlog?.eligible ?? (await loadPlannerInventory());
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
      return { plan: result.output, inventory, backlog, head, branch };
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
    const planned = await planNextBatch(iteration);
    const plan = planned.plan;
    await agentMap.recordPlan(iteration, plan);
    const issues = plan.issues;

    if (issues.length === 0) {
      if (planned.backlog?.snapshot.issues.length) {
        console.error(
          JSON.stringify(
            {
              head: planned.head,
              eligible: planned.backlog.eligible.map((issue) => issue.number),
              exclusions: planned.backlog.excluded.map(
                ({ kind, issue, reasons }) => ({
                  number: issue.number,
                  kind,
                  reasons,
                }),
              ),
              decisions: plan.decisions,
            },
            null,
            2,
          ),
        );
        if (
          planned.backlog.eligible.length ||
          planned.backlog.excluded.some(
            (issue) => issue.kind === "implementation",
          )
        )
          throw new Error(
            "No eligible batch selected while implementation issues remain. Resolve the recorded dependencies, holds or project qualification gates before resuming.",
          );
        const qualification = planned.backlog.excluded
          .filter((issue) => issue.kind === "qualification")
          .map((row) => row.issue.number);
        console.log(
          `Local implementation is complete; external qualification remains pending for: ${qualification.join(", ") || "none"}. Meta issues remain owned by their project workflow.`,
        );
        return;
      }
      console.log("No eligible work remains in the configured inventory.");
      return;
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

    // Refresh once before parallel worktree creation; remote reads stay asynchronous.
    if (planned.backlog) {
      await sandcastle.admitGitHubReadinessBatch(
        {
          ...readiness,
          repository: readiness.repository!,
          cwd: process.cwd(),
        },
        {
          snapshot: planned.backlog.snapshot,
          branch: planned.branch,
          issues: issues.map((issue) => Number(issue.id)),
        },
      );
    } else {
      const fresh = await loadPlannerInventory();
      const identity = (row: unknown) => {
        const candidate = z
          .object({
            id: z.union([z.string(), z.number()]).optional(),
            number: z.number().optional(),
          })
          .passthrough()
          .parse(row);
        return String(candidate.id ?? candidate.number);
      };
      for (const issue of issues) {
        const before = planned.inventory.find(
          (row) => identity(row) === issue.id,
        );
        const after = fresh.find((row) => identity(row) === issue.id);
        if (
          !before ||
          !after ||
          JSON.stringify(before) !== JSON.stringify(after)
        )
          throw new Error(
            `Issue ${issue.id} changed after planning; refresh the plan before execution.`,
          );
      }
    }
    // Head the integration checkout must be at; advances after each merge.
    let integrationHead = planned.head;
    const assertBaseline = async () => {
      if (
        (await runHost("git", ["rev-parse", "HEAD"])).trim() !==
          integrationHead ||
        (await currentBranch()) !== planned.branch ||
        (await runHost("git", ["status", "--porcelain"])).trim()
      )
        throw new Error(
          "Integration checkout changed after planning; keep work and reconcile before merging.",
        );
    };
    await assertBaseline();
    const batchBaseSha = planned.head;

    // Per-branch mode: a FIFO queue integrates one approved branch at a time
    // while other pipelines continue in their own worktrees.
    const mergedIssues: typeof issues = [];
    const retainedMerges: { issue: (typeof issues)[number]; error: unknown }[] =
      [];
    let mergeStop: unknown;
    let mergeQueue = Promise.resolve();
    const enqueueMerge = (issue: (typeof issues)[number]) => {
      mergeQueue = mergeQueue.then(async () => {
        if (mergeStop !== undefined) return;
        const before = integrationHead;
        try {
          await integrate([issue]);
          mergedIssues.push(issue);
        } catch (error) {
          // A merger that left the checkout untouched affects only this branch.
          const untouched =
            integrationHead === before &&
            (await runHost("git", ["rev-parse", "HEAD"])).trim() === before &&
            (await currentBranch()) === planned.branch &&
            !(await runHost("git", ["status", "--porcelain"])).trim();
          if (untouched) {
            retainedMerges.push({ issue, error });
            console.warn(
              `  ! ${issue.id} merge failed; branch retained: ${error}`,
            );
          } else mergeStop = error;
        }
      });
    };

    const settled = await Promise.allSettled(
      issues.map(async (issue) => {
        // Provider/infrastructure failures retry on the retained branch;
        // task failures (blocked, unapproved) are never retried.
        const result = await sandcastle.runTaskWithRetries({
          retries: TASK_RETRIES,
          breaker,
          onAttempt: (attempt) => {
            if (attempt.outcome !== "succeeded")
              console.warn(
                `  ! ${issue.id} attempt ${attempt.attempt} failed (${attempt.outcome}): ${attempt.error}`,
              );
          },
          run: async (attempt) => {
            let sandbox: sandcastle.Sandbox | undefined;
            try {
              // Include sandbox setup in the observed implementer phase.
              // One implementer invocation serves the first attempt and every
              // review repair round; findings are empty on the first attempt.
              const runImplementer = (
                logging: sandcastle.LoggingOption,
                reviewFindings: string,
              ) =>
                sandbox!.run({
                  logging,
                  name: "implementer",
                  maxIterations: 100,
                  agent: sandcastle.claudeCode("claude-sonnet-4-6"),
                  completionSignal: [
                    "<promise>COMPLETE</promise>",
                    "<promise>BLOCKED</promise>",
                  ],
                  promptFile: "./.sandcastle/implement-prompt.md",
                  promptArgs: {
                    TASK_ID: issue.id,
                    ISSUE_TITLE: issue.title,
                    BRANCH: issue.branch,
                    REVIEW_FINDINGS: reviewFindings,
                  },
                });
              const implement = await agentMap.track(
                {
                  batch: iteration,
                  role: "implementer",
                  issueId: issue.id,
                  title:
                    attempt === 1
                      ? issue.title
                      : `${issue.title} (retry ${attempt})`,
                  branch: issue.branch,
                },
                async (logging) => {
                  sandbox = await sandcastle.createSandbox({
                    branch: issue.branch,
                    baseBranch: batchBaseSha,
                    sandbox: docker({ env: trackerEnvironment }),
                    hooks,
                    copyToWorktree,
                  });

                  return runImplementer(logging, "");
                },
              );

              if (implement.completionSignal !== "<promise>COMPLETE</promise>")
                throw new Error(
                  `Implementation did not complete for issue ${issue.id}; retain the branch and leave its issue open.`,
                );
              const implementationCommits =
                implement.commits.length > 0
                  ? implement.commits
                  : (
                      await runHost("git", [
                        "rev-list",
                        `${batchBaseSha}..${issue.branch}`,
                        "--",
                      ])
                    )
                      .trim()
                      .split("\n")
                      .filter(Boolean)
                      .map((sha) => ({ sha }));
              // Retained commits still require a fresh completed review before merging.
              if (sandbox && implementationCommits.length > 0) {
                // Bounded review→repair loop: only an approved verdict is merged.
                const loop = await sandcastle.runReviewLoop({
                  maxRepairRounds: MAX_REPAIR_ROUNDS,
                  review: (round) =>
                    agentMap.track(
                      {
                        batch: iteration,
                        role: "reviewer",
                        issueId: issue.id,
                        title:
                          round === 1
                            ? issue.title
                            : `${issue.title} (re-review ${round})`,
                        branch: issue.branch,
                      },
                      (logging) =>
                        sandcastle.withReviewVerdict(
                          sandbox!.run({
                            logging,
                            name: "reviewer",
                            maxIterations: 1,
                            agent: sandcastle.claudeCode("claude-sonnet-4-6"),
                            completionSignal: [
                              "<promise>COMPLETE</promise>",
                              "<promise>BLOCKED</promise>",
                            ],
                            promptFile: "./.sandcastle/review-prompt.md",
                            promptArgs: {
                              TASK_ID: issue.id,
                              ISSUE_TITLE: issue.title,
                              BRANCH: issue.branch,
                              REVIEW_BASE_SHA: batchBaseSha,
                              REVIEW_ROUND: String(round),
                              REVIEW_REPAIR_ROUNDS: String(MAX_REPAIR_ROUNDS),
                            },
                          }),
                        ),
                    ),
                  repair: (findings, round) =>
                    agentMap.track(
                      {
                        batch: iteration,
                        role: "implementer",
                        issueId: issue.id,
                        title: `${issue.title} (repair ${round})`,
                        branch: issue.branch,
                      },
                      (logging) =>
                        runImplementer(
                          logging,
                          sandcastle.formatReviewFindings(findings),
                        ),
                    ),
                });
                if (loop.outcome !== "approved")
                  console.warn(
                    `  ! ${issue.id} review ${loop.outcome} after ${loop.rounds.length} round(s); branch retained.\n` +
                      (sandcastle.formatReviewFindings(loop.findings) ||
                        loop.rounds.at(-1)?.error ||
                        ""),
                  );

                // Merge commits from every run so the merge phase sees all of them.
                // Each sandbox.run() only returns commits from its own run.
                return {
                  ...loop.last,
                  completionSignal:
                    loop.outcome === "approved"
                      ? "<promise>COMPLETE</promise>"
                      : "<promise>BLOCKED</promise>",
                  commits: [...implementationCommits, ...loop.commits],
                };
              }

              return implement;
            } finally {
              await sandbox?.close();
            }
          },
        });
        if (
          MERGE_MODE === "per-branch" &&
          result.commits.length > 0 &&
          result.completionSignal === "<promise>COMPLETE</promise>"
        )
          enqueueMerge(issue);
        return result;
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

    if (breaker.open) {
      await agentMap.finishBatch(iteration);
      throw new Error(
        `Provider unavailable after ${breaker.consecutiveProviderFailures} consecutive provider failures; branches are retained. Check provider status, authentication and fallbacks, then resume.`,
      );
    }

    // Planning waits for every pipeline and the merge queue to settle.
    await mergeQueue;
    if (mergeStop !== undefined) throw mergeStop;

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

    if (
      completedBranches.length === 0 ||
      (MERGE_MODE === "per-branch" && mergedIssues.length === 0)
    ) {
      await agentMap.finishBatch(iteration);
      throw new Error(
        "No verified implementation progress. Retain the branches and inspect failed or blocked stages before resuming.",
      );
    }

    if (MERGE_MODE === "batch") await integrate(completedIssues);

    // Integrate approved branches on the integration checkout. Guards: the
    // checkout is at the expected head and clean before the merger starts; the
    // merger must leave a clean, advanced head containing every branch; then
    // post-merge readiness/verification runs for exactly these branches.
    // Declared (hoisted) so the per-branch queue can call it while pipelines
    // run; kept after the pipelines so generated-profile anchors stay ordered.
    async function integrate(mergeIssues: typeof issues) {
      await assertBaseline();
      const base = integrationHead;
      const mergeBranches = mergeIssues.map((i) => i.branch);

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
          title:
            MERGE_MODE === "batch"
              ? "Integrate batch"
              : `Integrate ${mergeIssues.map((i) => i.id).join(", ")}`,
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
            completionSignal: [
              "<promise>COMPLETE</promise>",
              "<promise>BLOCKED</promise>",
            ],
            promptFile: "./.sandcastle/merge-prompt.md",
            promptArgs: {
              // A markdown list of branch names, one per line.
              BRANCHES: mergeBranches.map((b) => `- ${b}`).join("\n"),
              // A markdown list of issue IDs and titles, one per line.
              ISSUES: mergeIssues
                .map((i) => `- ${i.id}: ${i.title}`)
                .join("\n"),
              // The integration commit before any branch in this batch is merged.
              BATCH_BASE_SHA: base,
            },
          }),
      );

      if (merge.completionSignal !== "<promise>COMPLETE</promise>") {
        throw new Error(
          "Merge did not complete; readiness and the next planner are stopped",
        );
      }
      const integratedHead = (
        await runHost("git", ["rev-parse", "HEAD"])
      ).trim();
      if (
        integratedHead === base ||
        (await currentBranch()) !== planned.branch ||
        (await runHost("git", ["status", "--porcelain"])).trim()
      )
        throw new Error(
          "Merger did not produce a clean integrated checkout on the planned branch.",
        );
      for (const ref of [base, ...mergeBranches])
        await runHost("git", [
          "merge-base",
          "--is-ancestor",
          ref,
          integratedHead,
        ]);
      await reassess(iteration, {
        kind: "post-merge",
        base,
        branches: mergeBranches,
        issues: mergeIssues.map((issue) => Number(issue.id)),
        completionSignal: merge.completionSignal,
      });
      integrationHead = integratedHead;
    }
    await agentMap.finishBatch(iteration);

    console.log("\nBranches merged.");
  }

  if (
    readinessEnabled &&
    (
      await sandcastle.inspectGitHubReadinessBacklog({
        ...readiness,
        repository: readiness.repository!,
        cwd: process.cwd(),
      })
    ).snapshot.issues.length === 0
  )
    return;
  throw new Error(
    "Iteration limit reached; inspect the remaining backlog before starting another run.",
  );
}

try {
  await executeWorkflow();
  await agentMap.finish("completed");
} catch (error) {
  await agentMap.finish("failed");
  throw error;
}
