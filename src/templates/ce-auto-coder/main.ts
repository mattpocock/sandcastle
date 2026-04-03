// CE Auto-Coder — Autonomous CE-powered orchestration template
//
// Discovers work (GitHub issues, TODOs, optimizations, ideation), prioritizes
// by impact, and runs each task through a CE-style development lifecycle:
//   plan → review plan → work → review code → commit → merge
//
// Two operating modes:
//   auto       — fully autonomous, all tiers including ideation
//   supervised — pauses at ideation for user selection via interactive prompt
//
// Usage:
//   npx tsx .sandcastle/main.ts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.ts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration (from environment / .env)
// ---------------------------------------------------------------------------

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n))
    throw new Error(`${name} must be a number, got: ${raw}`);
  return n;
}

const modeRaw = process.env.MODE ?? "auto";
if (modeRaw !== "auto" && modeRaw !== "supervised") {
  throw new Error(`MODE must be 'auto' or 'supervised', got: ${modeRaw}`);
}
const MODE: "auto" | "supervised" = modeRaw;

const priorityRaw = process.env.PRIORITY_MODE ?? "tier-ordered";
if (priorityRaw !== "tier-ordered" && priorityRaw !== "cross-tier") {
  throw new Error(
    `PRIORITY_MODE must be 'tier-ordered' or 'cross-tier', got: ${priorityRaw}`,
  );
}
const PRIORITY_MODE: "tier-ordered" | "cross-tier" = priorityRaw;

const MAX_ITERATIONS = parseEnvInt("MAX_ITERATIONS", 50);
const CIRCUIT_BREAKER_THRESHOLD = parseEnvInt("CIRCUIT_BREAKER_THRESHOLD", 3);
const MAX_FILES_PER_IDEA = parseEnvInt("MAX_FILES_PER_IDEA", 10);

// Hooks run inside the sandbox before the agent starts.
const hooks = {
  onSandboxReady: [{ command: "npm install" }],
};

const copyToSandbox = ["node_modules"];

// Per-phase idle timeouts (seconds)
const TIMEOUT_PLAN = 900;
const TIMEOUT_WORK = 1200;
const TIMEOUT_REVIEW = 600;

// Run log path
const RUN_LOG_PATH = ".sandcastle/logs/ce-auto-coder-run.jsonl";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiscoveryItem {
  id: string;
  title: string;
  tier: "issue" | "todo" | "optimization" | "ideation";
  score: number;
  size: "trivial" | "standard" | "complex";
  files_affected?: number;
  viability?: boolean;
  description: string;
}

type TaskOutcome =
  | "completed"
  | "blocked"
  | "failed"
  | "skipped"
  | "conflicted";

interface TaskLogEntry {
  timestamp: string;
  task_id: string;
  task_title: string;
  tier: DiscoveryItem["tier"];
  size: DiscoveryItem["size"];
  outcome: TaskOutcome;
  duration_ms: number;
  iterations: number;
  phases_completed: string[];
  error_reason?: string;
}

interface ReviewResult {
  pass: boolean;
  findings_summary: { p0: number; p1: number; p2: number; p3: number };
  details: unknown[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseXmlTag<T>(stdout: string, tag: string): T | null {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = stdout.match(regex);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as T;
  } catch {
    return null;
  }
}

function validateDiscovery(
  parsed: unknown,
): parsed is { items: DiscoveryItem[] } {
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.items)) return false;
  // Filter out malformed items — require at minimum id, title, tier, score, size
  obj.items = (obj.items as unknown[]).filter((item) => {
    if (typeof item !== "object" || item === null) return false;
    const i = item as Record<string, unknown>;
    return (
      typeof i.id === "string" &&
      i.id.length > 0 &&
      typeof i.title === "string" &&
      typeof i.tier === "string" &&
      typeof i.score === "number" &&
      Number.isFinite(i.score) &&
      typeof i.size === "string"
    );
  });
  return true;
}

function validateReview(parsed: unknown): parsed is ReviewResult {
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pass !== "boolean") return false;
  const summary = obj.findings_summary as Record<string, unknown> | undefined;
  if (!summary) return false;
  return Number.isFinite(summary.p0) && Number.isFinite(summary.p1);
}

function logTask(entry: TaskLogEntry): void {
  try {
    const dir = ".sandcastle/logs";
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(RUN_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.warn("Failed to write run log entry:", err);
  }
}

const GIT_TIMEOUT = 60_000; // 60s timeout for git commands

function validateBranchName(branch: string): void {
  if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

function gitMerge(branch: string): "merged" | "conflicted" {
  validateBranchName(branch);
  try {
    execFileSync("git", ["merge", branch, "--no-edit"], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
    });
    execFileSync("git", ["branch", "-D", branch], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
    });
    return "merged";
  } catch {
    try {
      execFileSync("git", ["merge", "--abort"], {
        stdio: "pipe",
        timeout: GIT_TIMEOUT,
      });
    } catch {
      // merge --abort may fail if not in merge state
    }
    try {
      execFileSync("git", ["branch", "-D", branch], {
        stdio: "pipe",
        timeout: GIT_TIMEOUT,
      });
    } catch {
      // branch may not exist if sandbox failed early
    }
    return "conflicted";
  }
}

function deleteBranch(branch: string): void {
  validateBranchName(branch);
  try {
    execFileSync("git", ["branch", "-D", branch], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
    });
  } catch {
    // branch may not exist
  }
}

// ---------------------------------------------------------------------------
// Phase: Discovery
// ---------------------------------------------------------------------------

async function discover(): Promise<DiscoveryItem[]> {
  let result;
  try {
    result = await sandcastle.run({
      hooks,
      copyToSandbox,
      name: "discovery",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-sonnet-4-6"),
      promptFile: "./.sandcastle/discover-prompt.md",
      idleTimeoutSeconds: TIMEOUT_PLAN,
    });
  } catch (err) {
    console.warn("Discovery failed, likely preprocessing error:", err);
    return [];
  }

  const discovery = parseXmlTag<{ items: DiscoveryItem[] }>(
    result.stdout,
    "discovery",
  );

  if (!discovery || !validateDiscovery(discovery)) {
    console.warn("Discovery agent did not produce valid <discovery> output.");
    // Retry once with reformat instruction, including original output for context
    try {
      const retry = await sandcastle.run({
        hooks,
        copyToSandbox,
        name: "discovery-retry",
        maxIterations: 1,
        agent: sandcastle.claudeCode("claude-sonnet-4-6"),
        prompt: `Your previous discovery output was not parseable as valid XML-tagged JSON. Here is what you produced:\n\n${result.stdout.slice(0, 4000)}\n\nPlease reformat this as valid JSON wrapped in <discovery>{"items": [...]}</discovery> XML tags.`,
        idleTimeoutSeconds: TIMEOUT_PLAN,
      });
      const retryDiscovery = parseXmlTag<{ items: DiscoveryItem[] }>(
        retry.stdout,
        "discovery",
      );
      if (retryDiscovery && validateDiscovery(retryDiscovery))
        return retryDiscovery.items;
    } catch {
      // retry failed too
    }
    return [];
  }

  return discovery.items;
}

function filterAndSort(items: DiscoveryItem[]): DiscoveryItem[] {
  // Filter: skip issues assigned to others (handled in discovery prompt)
  // Filter: ideation items exceeding blast radius
  const filtered = items.filter((item) => {
    if (item.tier === "ideation") {
      if (item.viability === false) return false;
      if (
        item.files_affected !== undefined &&
        item.files_affected > MAX_FILES_PER_IDEA
      ) {
        return false;
      }
    }
    return true;
  });

  if (PRIORITY_MODE === "cross-tier") {
    // Unified scoring: sort all items by score descending
    return filtered.sort((a, b) => b.score - a.score);
  }

  // Tier-ordered: process tiers in order, sort within each tier
  const tierOrder: DiscoveryItem["tier"][] = [
    "issue",
    "todo",
    "optimization",
    "ideation",
  ];
  const byTier = new Map<DiscoveryItem["tier"], DiscoveryItem[]>();
  for (const item of filtered) {
    const list = byTier.get(item.tier) ?? [];
    list.push(item);
    byTier.set(item.tier, list);
  }

  const sorted: DiscoveryItem[] = [];
  for (const tier of tierOrder) {
    const tierItems = byTier.get(tier) ?? [];
    tierItems.sort((a, b) => b.score - a.score);
    sorted.push(...tierItems);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Phase: Supervised Ideation Selection
// ---------------------------------------------------------------------------

async function selectIdeationItems(
  items: DiscoveryItem[],
): Promise<DiscoveryItem[]> {
  if (MODE !== "supervised") return items;

  const ideationItems = items.filter((i) => i.tier === "ideation");
  const nonIdeationItems = items.filter((i) => i.tier !== "ideation");

  if (ideationItems.length === 0) return items;

  // Fail closed: skip ideation if no TTY
  if (!process.stdin.isTTY) {
    console.warn(
      "Supervised mode requires interactive TTY. Skipping ideation tier.",
    );
    return nonIdeationItems;
  }

  // Dynamic import to avoid loading @clack/prompts in auto mode
  let multiselect;
  try {
    ({ multiselect } = await import("@clack/prompts"));
  } catch {
    console.warn("@clack/prompts not available. Skipping ideation tier.");
    return nonIdeationItems;
  }

  const selected = await multiselect({
    message: "Select ideation items to execute:",
    options: ideationItems.map((item) => ({
      value: item.id,
      label: `[${item.score}] ${item.title}`,
      hint: item.description,
    })),
    required: false,
  });

  if (typeof selected === "symbol") {
    // User cancelled
    console.log("Ideation selection cancelled. Skipping ideation tier.");
    return nonIdeationItems;
  }

  const selectedSet = new Set(selected as string[]);
  const selectedItems = ideationItems.filter((i) => selectedSet.has(i.id));
  const rejectedItems = ideationItems.filter((i) => !selectedSet.has(i.id));

  // Log rejected items
  for (const item of rejectedItems) {
    logTask({
      timestamp: new Date().toISOString(),
      task_id: item.id,
      task_title: item.title,
      tier: item.tier,
      size: item.size,
      outcome: "skipped",
      duration_ms: 0,
      iterations: 0,
      phases_completed: [],
      error_reason: "Rejected by user in supervised mode",
    });
  }

  return [...nonIdeationItems, ...selectedItems];
}

// ---------------------------------------------------------------------------
// Phase: Review Loop (reusable for plan and code review)
// ---------------------------------------------------------------------------

async function reviewLoop(
  sandbox: Awaited<ReturnType<typeof sandcastle.createSandbox>>,
  promptFile: string,
  promptArgs: Record<string, string>,
  maxRounds: number,
): Promise<{ passed: boolean; iterations: number }> {
  let totalIterations = 0;

  for (let round = 0; round < maxRounds; round++) {
    let result;
    try {
      result = await sandbox.run({
        agent: sandcastle.claudeCode("claude-sonnet-4-6"),
        promptFile,
        promptArgs: { ...promptArgs, REVIEW_ROUND: String(round + 1) },
        maxIterations: 1,
        idleTimeoutSeconds: TIMEOUT_REVIEW,
      });
    } catch (err) {
      console.error(`Review round ${round + 1} threw:`, err);
      totalIterations++;
      return { passed: false, iterations: totalIterations };
    }
    totalIterations++;

    const review = parseXmlTag<ReviewResult>(result.stdout, "review");

    if (!review || !validateReview(review)) {
      // Malformed output — retry once
      if (round < maxRounds - 1) {
        console.warn(
          `Review round ${round + 1}: malformed output, retrying...`,
        );
        continue;
      }
      // Treat persistent malformed output as P0 finding
      return { passed: false, iterations: totalIterations };
    }

    if (review.findings_summary.p0 + review.findings_summary.p1 === 0) {
      return { passed: true, iterations: totalIterations };
    }

    console.log(
      `Review round ${round + 1}: P0=${review.findings_summary.p0} P1=${review.findings_summary.p1} — ${round < maxRounds - 1 ? "agent fixing..." : "max rounds reached"}`,
    );
  }

  return { passed: false, iterations: totalIterations };
}

// ---------------------------------------------------------------------------
// Phase: Execute Task (full CE lifecycle)
// ---------------------------------------------------------------------------

async function executeTask(task: DiscoveryItem): Promise<{
  outcome: TaskOutcome;
  iterations: number;
  phases: string[];
  error_reason?: string;
}> {
  const branch = `ce-auto-coder/${task.id}`;
  validateBranchName(branch);
  const phases: string[] = [];
  let iterations = 0;

  let sandbox;
  try {
    sandbox = await sandcastle.createSandbox({
      branch,
      hooks,
      copyToSandbox,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to create sandbox for ${task.id}:`, msg);
    deleteBranch(branch);
    return { outcome: "failed", iterations: 0, phases: [], error_reason: msg };
  }

  try {
    // --- Plan Phase (skip for trivial) ---
    let planFile: string | undefined;

    if (task.size !== "trivial") {
      const planResult = await sandbox.run({
        agent: sandcastle.claudeCode("claude-sonnet-4-6"),
        promptFile: "./.sandcastle/plan-prompt.md",
        promptArgs: {
          TASK_ID: task.id,
          TASK_TITLE: task.title,
          TASK_DESCRIPTION: task.description,
          TASK_TIER: task.tier,
        },
        maxIterations: 1,
        idleTimeoutSeconds: TIMEOUT_PLAN,
      });
      iterations++;
      phases.push("plan");

      const planOutput = parseXmlTag<{ plan_file: string }>(
        planResult.stdout,
        "plan_output",
      );
      if (!planOutput?.plan_file) {
        // Retry once
        console.warn("Plan phase did not produce <plan_output>. Retrying...");
        const retry = await sandbox.run({
          agent: sandcastle.claudeCode("claude-sonnet-4-6"),
          prompt: `Your previous output did not include a <plan_output> tag. Look in the sandbox for any plan files you may have written (e.g., docs/plans/), and output the path as <plan_output>{"plan_file": "path/to/plan.md"}</plan_output>.`,
          maxIterations: 1,
          idleTimeoutSeconds: TIMEOUT_PLAN,
        });
        iterations++;
        const retryOutput = parseXmlTag<{ plan_file: string }>(
          retry.stdout,
          "plan_output",
        );
        if (!retryOutput?.plan_file) {
          await sandbox.close();
          deleteBranch(branch);
          return { outcome: "blocked", iterations, phases };
        }
        planFile = retryOutput.plan_file;
      } else {
        planFile = planOutput.plan_file;
      }

      // --- Review Plan ---
      const planReview = await reviewLoop(
        sandbox,
        "./.sandcastle/review-plan-prompt.md",
        {
          TASK_ID: task.id,
          TASK_TITLE: task.title,
          PLAN_FILE: planFile,
        },
        3,
      );
      iterations += planReview.iterations;
      phases.push("review-plan");

      if (!planReview.passed) {
        console.log(`Task ${task.id}: plan review blocked after 3 rounds.`);
        await sandbox.close();
        deleteBranch(branch);
        return { outcome: "blocked", iterations, phases };
      }
    }

    // --- Work Phase ---
    const workPromptArgs: Record<string, string> = {
      TASK_ID: task.id,
      TASK_TITLE: task.title,
      TASK_DESCRIPTION: task.description,
      TASK_TIER: task.tier,
      TASK_SIZE: task.size,
    };
    workPromptArgs.PLAN_FILE = planFile ?? "none";

    const workResult = await sandbox.run({
      agent: sandcastle.claudeCode("claude-sonnet-4-6"),
      promptFile: "./.sandcastle/work-prompt.md",
      promptArgs: workPromptArgs,
      maxIterations: 100,
      idleTimeoutSeconds: TIMEOUT_WORK,
      completionSignal: "<promise>WORK_COMPLETE</promise>",
    });
    iterations += workResult.iterationsRun;
    phases.push("work");

    // --- Review Code ---
    const codeReview = await reviewLoop(
      sandbox,
      "./.sandcastle/review-code-prompt.md",
      {
        TASK_ID: task.id,
        TASK_TITLE: task.title,
        REVIEW_BASE_BRANCH: sandbox.branch,
      },
      3,
    );
    iterations += codeReview.iterations;
    phases.push("review-code");

    if (!codeReview.passed) {
      console.log(`Task ${task.id}: code review failed after 3 rounds.`);
      await sandbox.close();
      deleteBranch(branch);
      return { outcome: "failed", iterations, phases };
    }

    // --- Close sandbox and merge ---
    await sandbox.close();
    phases.push("merge");

    const mergeResult = gitMerge(branch);
    if (mergeResult === "conflicted") {
      return { outcome: "conflicted", iterations, phases };
    }

    return { outcome: "completed", iterations, phases };
  } catch (err) {
    // Unrecoverable error — clean up
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Task ${task.id} failed:`, errorMsg);
    try {
      await sandbox.close();
      deleteBranch(branch);
    } catch {
      // If close() throws, preserve branch for manual inspection (do NOT delete)
      console.warn(
        `Could not clean up branch ${branch}. Preserved for manual inspection.`,
      );
    }
    return {
      outcome: "failed",
      iterations,
      phases,
      error_reason: errorMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== CE Auto-Coder ===`);
  console.log(`Mode: ${MODE}`);
  console.log(`Max iterations: ${MAX_ITERATIONS}`);
  console.log(
    `Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
  );
  console.log(`Priority: ${PRIORITY_MODE}\n`);

  // --- Discovery ---
  console.log("Phase 1: Discovering work...\n");
  const rawItems = await discover();

  if (rawItems.length === 0) {
    console.log("No work discovered. Exiting.");
    return;
  }

  console.log(`Discovered ${rawItems.length} items across all tiers.`);

  // --- Filter, sort, and supervised selection ---
  const sorted = filterAndSort(rawItems);
  const tasks = await selectIdeationItems(sorted);

  if (tasks.length === 0) {
    console.log("No actionable work after filtering. Exiting.");
    return;
  }

  console.log(`\nPriority queue: ${tasks.length} tasks\n`);
  for (const task of tasks) {
    console.log(
      `  [${task.score}] ${task.tier}/${task.size}: ${task.title} (${task.id})`,
    );
  }

  // --- Execute tasks ---
  let totalIterations = 0;
  let consecutiveFailures = 0;
  const results: TaskLogEntry[] = [];

  for (const task of tasks) {
    // Budget check
    if (totalIterations >= MAX_ITERATIONS) {
      console.log(`\nIteration budget exhausted (${MAX_ITERATIONS}). Halting.`);
      break;
    }

    // Circuit breaker
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      console.error(
        `\nCircuit breaker: ${consecutiveFailures} consecutive failures. Halting.`,
      );
      break;
    }

    console.log(`\n--- Task: ${task.title} (${task.id}) [${task.size}] ---\n`);
    const startTime = Date.now();

    const { outcome, iterations, phases, error_reason } =
      await executeTask(task);
    totalIterations += iterations;

    const entry: TaskLogEntry = {
      timestamp: new Date().toISOString(),
      task_id: task.id,
      task_title: task.title,
      tier: task.tier,
      size: task.size,
      outcome,
      duration_ms: Date.now() - startTime,
      iterations,
      phases_completed: phases,
    };

    if (outcome === "completed") {
      consecutiveFailures = 0;
      console.log(`✓ Task ${task.id} completed and merged.`);
    } else {
      // Only actual failures count toward circuit breaker.
      // Blocked (plan review) and conflicted (merge) are expected workflow outcomes.
      if (outcome === "failed") {
        consecutiveFailures++;
      } else {
        consecutiveFailures = 0;
      }
      entry.error_reason = error_reason ?? `Task ${outcome}`;
      console.log(`✗ Task ${task.id}: ${outcome}`);
    }

    logTask(entry);
    results.push(entry);
  }

  // --- Summary ---
  const completed = results.filter((r) => r.outcome === "completed").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  const blocked = results.filter((r) => r.outcome === "blocked").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const conflicted = results.filter((r) => r.outcome === "conflicted").length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration_ms, 0);

  console.log(`\n=== Run Summary ===`);
  console.log(`Completed: ${completed}`);
  console.log(`Failed:    ${failed}`);
  console.log(`Blocked:   ${blocked}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Conflicted: ${conflicted}`);
  console.log(`Total iterations: ${totalIterations}`);
  console.log(`Total duration: ${Math.round(totalDuration / 1000)}s`);
  console.log(`Run log: ${RUN_LOG_PATH}`);
  console.log(`\nAll done.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
