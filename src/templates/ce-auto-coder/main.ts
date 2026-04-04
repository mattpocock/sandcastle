// CE Auto-Coder v2 — Autonomous CE-powered orchestration template
//
// Discovers work (GitHub issues, TODOs, optimizations, ideation), prioritizes
// by impact, and runs each task through a CE-style development lifecycle:
//   plan → review plan (loop until clean) → work → review code (loop until clean) → merge
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
import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

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
const MIN_TASK_BUDGET = 8;

// Hooks run inside the sandbox before the agent starts.
const hooks = {
  onSandboxReady: [
    // Trust the mounted workspace directory for git operations
    {
      command: "git config --global --add safe.directory /home/agent/workspace",
    },
    { command: "npm install" },
  ],
};

const copyToSandbox = ["node_modules"];

// Per-phase idle timeouts (seconds)
const TIMEOUT_PLAN = 900;
const TIMEOUT_WORK = 1200;
const TIMEOUT_REVIEW = 600;

// Run log and manifest paths
const RUN_LOG_PATH = ".sandcastle/logs/ce-auto-coder-run.jsonl";
const MANIFEST_PATH = ".sandcastle/current-run-branches.txt";

// XML retry cap
const MAX_XML_RETRIES = 5;

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
  | "conflicted"
  | "needs-human"
  | "budget-exhausted";

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

interface ReviewLoopResult {
  passed: boolean;
  stuck: boolean;
  budgetExhausted: boolean;
  iterations: number;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GIT_TIMEOUT = 60_000;

function validateBranchName(branch: string): void {
  if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

// --- Branch manifest (track current-run branches for cleanup) ---

function recordBranch(branch: string): void {
  try {
    const dir = ".sandcastle";
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(MANIFEST_PATH, branch + "\n");
  } catch {
    // non-critical
  }
}

function removeBranchFromManifest(branch: string): void {
  try {
    const branches = readManifest().filter((b) => b !== branch);
    writeFileSync(
      MANIFEST_PATH,
      branches.join("\n") + (branches.length ? "\n" : ""),
    );
  } catch {
    // non-critical
  }
}

function readManifest(): string[] {
  try {
    if (!existsSync(MANIFEST_PATH)) return [];
    return readFileSync(MANIFEST_PATH, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function clearManifest(): void {
  try {
    writeFileSync(MANIFEST_PATH, "");
  } catch {
    // non-critical
  }
}

// --- Git operations ---

function gitMerge(branch: string): "merged" | "conflicted" {
  validateBranchName(branch);

  // First attempt: direct merge
  try {
    execFileSync("git", ["merge", branch, "--no-edit"], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
    });
    // Success — delete the branch and remove from manifest
    execFileSync("git", ["branch", "-D", branch], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
    });
    removeBranchFromManifest(branch);
    return "merged";
  } catch {
    try {
      execFileSync("git", ["merge", "--abort"], {
        stdio: "pipe",
        timeout: GIT_TIMEOUT,
      });
    } catch {
      // may not be in merge state
    }
  }

  // Second attempt: rebase then fast-forward
  const currentBranch = execFileSync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf-8", timeout: GIT_TIMEOUT },
  ).trim();

  try {
    execFileSync("git", ["checkout", branch], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
    });
    execFileSync("git", ["rebase", currentBranch], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
    });
    execFileSync("git", ["checkout", currentBranch], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
    });
    execFileSync("git", ["merge", branch, "--no-edit"], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
    });
    // Success — delete the branch and remove from manifest
    execFileSync("git", ["branch", "-D", branch], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
    });
    removeBranchFromManifest(branch);
    console.log("  Merged via rebase after initial conflict.");
    return "merged";
  } catch {
    // Rebase or post-rebase merge failed — preserve the branch
    try {
      execFileSync("git", ["merge", "--abort"], {
        stdio: "pipe",
        timeout: GIT_TIMEOUT,
      });
    } catch {
      /* may not be in merge state */
    }
    try {
      execFileSync("git", ["rebase", "--abort"], {
        stdio: "pipe",
        timeout: GIT_TIMEOUT,
      });
    } catch {
      /* may not be in rebase state */
    }
    try {
      execFileSync("git", ["checkout", currentBranch], {
        stdio: "pipe",
        timeout: GIT_TIMEOUT,
      });
    } catch {
      /* already on current branch */
    }
    // Branch preserved for inspection — NOT deleted
    console.log(`  Branch preserved: ${branch} (merge conflict)`);
    return "conflicted";
  }
}

// ---------------------------------------------------------------------------
// Phase: Discovery (with retry loop)
// ---------------------------------------------------------------------------

async function discover(): Promise<DiscoveryItem[]> {
  let lastStdout = "";

  for (let attempt = 0; attempt < MAX_XML_RETRIES; attempt++) {
    try {
      const isRetry = attempt > 0;
      const result = await sandcastle.run({
        hooks,
        copyToSandbox,
        name: isRetry ? `discovery-retry-${attempt}` : "discovery",
        maxIterations: 1,
        agent: sandcastle.claudeCode("claude-sonnet-4-6"),
        ...(isRetry
          ? {
              prompt: `Your previous discovery output was not parseable as valid XML-tagged JSON. Here is what you produced:\n\n${lastStdout.slice(0, 4000)}\n\nPlease reformat this as valid JSON wrapped in <discovery>{"items": [...]}</discovery> XML tags.`,
            }
          : { promptFile: "./.sandcastle/discover-prompt.md" }),
        idleTimeoutSeconds: TIMEOUT_PLAN,
      });
      lastStdout = result.stdout;

      const discovery = parseXmlTag<{ items: DiscoveryItem[] }>(
        result.stdout,
        "discovery",
      );
      if (discovery && validateDiscovery(discovery)) {
        return discovery.items;
      }
      console.warn(
        `Discovery attempt ${attempt + 1}: invalid output, retrying...`,
      );
    } catch (err) {
      console.warn(
        `Discovery attempt ${attempt + 1} threw:`,
        err instanceof Error ? err.message : err,
      );
      // Allow retries for transient errors (Docker, network)
      // Only bail immediately if this is the last attempt
      if (attempt >= MAX_XML_RETRIES - 1) return [];
    }
  }

  console.warn(`Discovery failed after ${MAX_XML_RETRIES} attempts. No items.`);
  return [];
}

function filterAndSort(items: DiscoveryItem[]): DiscoveryItem[] {
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
    return filtered.sort((a, b) => b.score - a.score);
  }

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

  if (!process.stdin.isTTY) {
    console.warn(
      "Supervised mode requires interactive TTY. Skipping ideation tier.",
    );
    return nonIdeationItems;
  }

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
    console.log("Ideation selection cancelled. Skipping ideation tier.");
    return nonIdeationItems;
  }

  const selectedSet = new Set(selected as string[]);
  const selectedItems = ideationItems.filter((i) => selectedSet.has(i.id));
  const rejectedItems = ideationItems.filter((i) => !selectedSet.has(i.id));

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
// Phase: Review Loop — loop until clean (v2)
//
// Exits on: (a) 0 P0/P1 = pass, (b) no progress for 3 rounds = stuck,
//           (c) task budget exhausted, (d) sandbox error
// ---------------------------------------------------------------------------

async function reviewLoop(
  sandbox: Awaited<ReturnType<typeof sandcastle.createSandbox>>,
  promptFile: string,
  promptArgs: Record<string, string>,
  taskBudget: number,
): Promise<ReviewLoopResult> {
  let totalIterations = 0;
  let minP0P1Seen = Infinity;
  let roundsWithoutImprovement = 0;
  let round = 0;

  while (totalIterations < taskBudget) {
    round++;
    let result;
    try {
      result = await sandbox.run({
        agent: sandcastle.claudeCode("claude-sonnet-4-6"),
        promptFile,
        promptArgs: { ...promptArgs, REVIEW_ROUND: String(round) },
        maxIterations: 10,
        idleTimeoutSeconds: TIMEOUT_REVIEW,
      });
    } catch (err) {
      console.error(`Review round ${round} threw:`, err);
      totalIterations++;
      return {
        passed: false,
        stuck: false,
        budgetExhausted: false,
        iterations: totalIterations,
      };
    }
    totalIterations++;

    const review = parseXmlTag<ReviewResult>(result.stdout, "review");

    if (!review || !validateReview(review)) {
      // Malformed output — counts as "no improvement" toward stuck detection
      roundsWithoutImprovement++;
      console.warn(
        `Review round ${round}: malformed output (stale: ${roundsWithoutImprovement}/3), retrying...`,
      );
      if (roundsWithoutImprovement >= 3) {
        console.log(
          `Review: STUCK — ${roundsWithoutImprovement} rounds without valid/improving output.`,
        );
        return {
          passed: false,
          stuck: true,
          budgetExhausted: false,
          iterations: totalIterations,
        };
      }
      continue;
    }

    const currentP0P1 = review.findings_summary.p0 + review.findings_summary.p1;

    // Exit: clean pass
    if (currentP0P1 === 0) {
      console.log(`Review round ${round}: PASS (0 P0/P1 findings)`);
      return {
        passed: true,
        stuck: false,
        budgetExhausted: false,
        iterations: totalIterations,
      };
    }

    // Track progress against historical minimum
    if (currentP0P1 < minP0P1Seen) {
      minP0P1Seen = currentP0P1;
      roundsWithoutImprovement = 0;
    } else {
      roundsWithoutImprovement++;
    }

    // Exit: stuck (no improvement for 3 rounds)
    if (roundsWithoutImprovement >= 3) {
      console.log(
        `Review round ${round}: STUCK — P0+P1=${currentP0P1} has not improved beyond ${minP0P1Seen} for 3 rounds.`,
      );
      return {
        passed: false,
        stuck: true,
        budgetExhausted: false,
        iterations: totalIterations,
      };
    }

    console.log(
      `Review round ${round}: P0=${review.findings_summary.p0} P1=${review.findings_summary.p1} (min seen: ${minP0P1Seen}, stale rounds: ${roundsWithoutImprovement}/3) — agent fixing...`,
    );
  }

  // Budget exhausted
  console.log(
    `Review: task budget exhausted after ${round} rounds (${totalIterations} iterations).`,
  );
  return {
    passed: false,
    stuck: false,
    budgetExhausted: true,
    iterations: totalIterations,
  };
}

// ---------------------------------------------------------------------------
// Phase: Execute Task (full CE lifecycle)
// ---------------------------------------------------------------------------

async function executeTask(
  task: DiscoveryItem,
  taskBudget: number,
): Promise<{
  outcome: TaskOutcome;
  iterations: number;
  phases: string[];
  error_reason?: string;
}> {
  const safeBranchId = task.id.replace(/[^a-zA-Z0-9._\/-]/g, "-");
  const branch = `ce-auto-coder/${safeBranchId}`;
  const phases: string[] = [];
  let iterations = 0;
  let remainingBudget = taskBudget;

  // Capture the current base branch before creating the task branch
  let baseBranch = "main";
  try {
    baseBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT,
    }).trim();
  } catch {
    // fallback to "main"
  }

  let sandbox;
  try {
    validateBranchName(branch);
    sandbox = await sandcastle.createSandbox({
      branch,
      hooks,
      copyToSandbox,
    });
    recordBranch(branch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to create sandbox for ${task.id}:`, msg);
    return { outcome: "failed", iterations: 0, phases: [], error_reason: msg };
  }

  try {
    // --- Plan Phase (skip for trivial) ---
    let planFile: string | undefined;

    if (task.size !== "trivial") {
      // Plan with retry loop for XML output
      for (
        let planAttempt = 0;
        planAttempt < MAX_XML_RETRIES && remainingBudget > 0;
        planAttempt++
      ) {
        const planResult = await sandbox.run({
          agent: sandcastle.claudeCode("claude-sonnet-4-6"),
          promptFile: "./.sandcastle/plan-prompt.md",
          promptArgs: {
            TASK_ID: task.id,
            TASK_TITLE: task.title,
            TASK_DESCRIPTION: task.description,
            TASK_TIER: task.tier,
          },
          maxIterations: 10,
          idleTimeoutSeconds: TIMEOUT_PLAN,
        });
        iterations++;
        remainingBudget--;
        if (planAttempt === 0) phases.push("plan");

        const planOutput = parseXmlTag<{ plan_file: string }>(
          planResult.stdout,
          "plan_output",
        );
        if (planOutput?.plan_file) {
          planFile = planOutput.plan_file;
          break;
        }
        console.warn(
          `Plan attempt ${planAttempt + 1}: no <plan_output>, retrying...`,
        );
      }

      if (!planFile) {
        await sandbox.close();
        console.log(`  Branch preserved: ${branch} (plan output missing)`);
        return { outcome: "blocked", iterations, phases };
      }

      // --- Review Plan (loop until clean) ---
      const planReview = await reviewLoop(
        sandbox,
        "./.sandcastle/review-plan-prompt.md",
        {
          TASK_ID: task.id,
          TASK_TITLE: task.title,
          PLAN_FILE: planFile,
        },
        remainingBudget,
      );
      iterations += planReview.iterations;
      remainingBudget -= planReview.iterations;
      phases.push("review-plan");

      if (!planReview.passed) {
        const reason = planReview.stuck
          ? "stuck"
          : planReview.budgetExhausted
            ? "budget"
            : "failed";
        console.log(
          `Task ${task.id}: plan review ${reason} after ${planReview.iterations} rounds.`,
        );
        await sandbox.close();
        console.log(`  Branch preserved: ${branch} (plan review ${reason})`);
        return {
          outcome: planReview.stuck ? "needs-human" : "budget-exhausted",
          iterations,
          phases,
        };
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
    iterations++;
    remainingBudget--;
    phases.push("work");

    // --- Review Code (loop until clean) ---
    const codeReview = await reviewLoop(
      sandbox,
      "./.sandcastle/review-code-prompt.md",
      {
        TASK_ID: task.id,
        TASK_TITLE: task.title,
        REVIEW_BASE_BRANCH: baseBranch,
      },
      remainingBudget,
    );
    iterations += codeReview.iterations;
    remainingBudget -= codeReview.iterations;
    phases.push("review-code");

    if (!codeReview.passed) {
      const reason = codeReview.stuck
        ? "stuck"
        : codeReview.budgetExhausted
          ? "budget"
          : "failed";
      console.log(`Task ${task.id}: code review ${reason}.`);
      await sandbox.close();
      console.log(`  Branch preserved: ${branch} (code review ${reason})`);
      return {
        outcome: codeReview.stuck ? "needs-human" : "budget-exhausted",
        iterations,
        phases,
      };
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
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Task ${task.id} failed:`, errorMsg);
    try {
      await sandbox.close();
    } catch {
      console.warn(`Could not close sandbox for ${branch}.`);
    }
    console.log(
      `  Branch preserved: ${branch} (error: ${errorMsg.slice(0, 80)})`,
    );
    return {
      outcome: "failed",
      iterations,
      phases,
      error_reason: errorMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Startup: Cleanup stale resources
// ---------------------------------------------------------------------------

function cleanupStaleContainers(): void {
  try {
    const output = execFileSync(
      "docker",
      ["ps", "-a", "--filter", "name=sandcastle-", "--format", "{{.Names}}"],
      { encoding: "utf-8", timeout: GIT_TIMEOUT },
    ).trim();
    if (output) {
      const containers = output.split("\n").filter(Boolean);
      for (const name of containers) {
        try {
          execFileSync("docker", ["rm", "-f", name], {
            stdio: "pipe",
            timeout: GIT_TIMEOUT,
          });
          console.log(`  Cleaned stale container: ${name}`);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // docker ps failed
  }
}

function cleanupStaleWorktrees(): void {
  const worktreeDir = ".sandcastle/worktrees";
  try {
    if (!existsSync(worktreeDir)) return;
    const entries = execFileSync("ls", [worktreeDir], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT,
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    if (entries.length > 0) {
      console.log(`  Found ${entries.length} stale worktrees — cleaning...`);
      try {
        execFileSync("git", ["worktree", "prune"], {
          stdio: "pipe",
          timeout: GIT_TIMEOUT,
        });
      } catch {
        // prune may fail
      }
      for (const entry of entries) {
        try {
          execFileSync("rm", ["-rf", `${worktreeDir}/${entry}`], {
            stdio: "pipe",
            timeout: GIT_TIMEOUT,
          });
        } catch {
          // ignore
        }
      }
      console.log("  Worktree cleanup done.");
    }
  } catch {
    // not critical
  }
}

function cleanupManifestBranches(): void {
  const branches = readManifest();
  if (branches.length === 0) return;
  console.log(`  Cleaning ${branches.length} branches from previous run...`);
  for (const branch of branches) {
    try {
      execFileSync("git", ["branch", "-D", branch], {
        stdio: "pipe",
        timeout: GIT_TIMEOUT,
      });
    } catch {
      // branch may not exist
    }
  }
  clearManifest();
}

const MIN_DISK_MB = 2000;

function checkDiskSpace(): boolean {
  try {
    const output = execFileSync("df", ["-m", "."], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT,
    })
      .trim()
      .split("\n");
    if (output.length > 1) {
      const parts = output[1]!.split(/\s+/);
      const availMB = parseInt(parts[3]!, 10);
      if (availMB < MIN_DISK_MB) {
        console.error(
          `Disk space critically low: ${availMB}MB available (minimum ${MIN_DISK_MB}MB). Halting.`,
        );
        return false;
      }
    }
  } catch {
    // can't check — continue
  }
  return true;
}

function reportDiskUsage(): void {
  try {
    const dfOutput = execFileSync("df", ["-h", "."], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT,
    })
      .trim()
      .split("\n");
    if (dfOutput.length > 1) {
      const parts = dfOutput[1]!.split(/\s+/);
      console.log(`  Disk: ${parts[3]} available (${parts[4]} used)`);
    }
  } catch {
    // not critical
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== CE Auto-Coder v2 ===`);
  console.log(`Mode: ${MODE}`);
  console.log(`Max iterations: ${MAX_ITERATIONS}`);
  console.log(
    `Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
  );
  console.log(`Priority: ${PRIORITY_MODE}\n`);

  // Startup cleanup
  console.log("Startup cleanup...");
  cleanupStaleContainers();
  cleanupStaleWorktrees();
  cleanupManifestBranches();
  reportDiskUsage();
  console.log("");

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

  // Calculate per-task budget
  const perTaskBudget = Math.max(
    MIN_TASK_BUDGET,
    Math.floor(MAX_ITERATIONS / tasks.length),
  );
  console.log(`\nPer-task budget: ${perTaskBudget} iterations\n`);

  // --- Execute tasks ---
  let totalIterations = 0;
  let consecutiveFailures = 0;
  const results: TaskLogEntry[] = [];

  for (const task of tasks) {
    // Global budget check
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

    // Disk space check
    if (!checkDiskSpace()) {
      break;
    }

    console.log(`\n--- Task: ${task.title} (${task.id}) [${task.size}] ---\n`);
    const startTime = Date.now();

    // Calculate remaining budget for this task (min of per-task cap and global remaining)
    const remainingGlobal = MAX_ITERATIONS - totalIterations;
    const effectiveBudget = Math.min(perTaskBudget, remainingGlobal);

    const { outcome, iterations, phases, error_reason } = await executeTask(
      task,
      effectiveBudget,
    );
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

    // Small delay between tasks to prevent Docker daemon rate limiting
    if (tasks.indexOf(task) < tasks.length - 1) {
      await sleep(2000);
    }
  }

  // --- Summary ---
  const completed = results.filter((r) => r.outcome === "completed").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  const blocked = results.filter((r) => r.outcome === "blocked").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const conflicted = results.filter((r) => r.outcome === "conflicted").length;
  const needsHuman = results.filter((r) => r.outcome === "needs-human").length;
  const budgetExhausted = results.filter(
    (r) => r.outcome === "budget-exhausted",
  ).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration_ms, 0);

  console.log(`\n=== Run Summary ===`);
  console.log(`Completed:       ${completed}`);
  console.log(`Failed:          ${failed}`);
  console.log(`Blocked:         ${blocked}`);
  console.log(`Needs human:     ${needsHuman}`);
  console.log(`Budget exhausted: ${budgetExhausted}`);
  console.log(`Conflicted:      ${conflicted}`);
  console.log(`Skipped:         ${skipped}`);
  console.log(`Total iterations: ${totalIterations}`);
  console.log(`Total duration: ${Math.round(totalDuration / 1000)}s`);
  console.log(`Run log: ${RUN_LOG_PATH}`);

  // List preserved branches
  try {
    const branches = execFileSync(
      "git",
      ["branch", "--list", "ce-auto-coder/*"],
      { encoding: "utf-8", timeout: GIT_TIMEOUT },
    )
      .trim()
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
    if (branches.length > 0) {
      console.log(`\nPreserved branches (inspect or resume):`);
      for (const b of branches) {
        console.log(`  git diff HEAD...${b}`);
      }
    }
  } catch {
    // branch listing failed
  }

  console.log(`\nAll done.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
