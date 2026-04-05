// CE Auto-Coder — Pure helpers and types
//
// Extracted from main.ts for testability. This module has no side effects
// and no dependency on process.env or the sandcastle runtime.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveryItem {
  id: string;
  title: string;
  tier: "issue" | "todo" | "optimization" | "ideation";
  score: number;
  size: "trivial" | "standard" | "complex";
  files_affected?: number;
  viability?: boolean;
  description: string;
}

export type TaskOutcome =
  | "completed"
  | "blocked"
  | "failed"
  | "skipped"
  | "conflicted"
  | "needs-human"
  | "budget-exhausted";

export interface TaskLogEntry {
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

export interface ReviewResult {
  pass: boolean;
  findings_summary: { p0: number; p1: number; p2: number; p3: number };
  details: unknown[];
}

export interface ReviewLoopResult {
  passed: boolean;
  stuck: boolean;
  budgetExhausted: boolean;
  iterations: number;
}

// ---------------------------------------------------------------------------
// Configuration type for filterAndSort
// ---------------------------------------------------------------------------

export interface FilterAndSortConfig {
  priorityMode: "tier-ordered" | "cross-tier";
  maxFilesPerIdea: number;
}

// ---------------------------------------------------------------------------
// Stuck detection state machine types
// ---------------------------------------------------------------------------

export interface ReviewState {
  p0p1Count: number;
  minP0P1Seen: number;
  roundsWithoutImprovement: number;
  budgetRemaining: number;
  isValidOutput: boolean;
  sandboxError: boolean;
}

export type ReviewAction =
  | { action: "pass" }
  | {
      action: "continue";
      minP0P1Seen: number;
      roundsWithoutImprovement: number;
    }
  | { action: "retry"; roundsWithoutImprovement: number }
  | { action: "stuck" }
  | { action: "budget-exhausted" }
  | { action: "error" };

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

export function parseXmlTag<T>(stdout: string, tag: string): T | null {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = stdout.match(regex);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as T;
  } catch {
    return null;
  }
}

export function validateDiscovery(
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

export function validateReview(parsed: unknown): parsed is ReviewResult {
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pass !== "boolean") return false;
  const summary = obj.findings_summary as Record<string, unknown> | undefined;
  if (!summary) return false;
  return Number.isFinite(summary.p0) && Number.isFinite(summary.p1);
}

export function validateBranchName(branch: string): void {
  if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

export function filterAndSort(
  items: DiscoveryItem[],
  config: FilterAndSortConfig,
): DiscoveryItem[] {
  const filtered = items.filter((item) => {
    if (item.tier === "ideation") {
      if (item.viability === false) return false;
      if (
        item.files_affected !== undefined &&
        item.files_affected > config.maxFilesPerIdea
      ) {
        return false;
      }
    }
    return true;
  });

  if (config.priorityMode === "cross-tier") {
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
// Stuck detection state machine
//
// Pure function: takes the current review state, returns the next action.
// The caller (reviewLoop) is responsible for:
//   - Calling sandbox.run() and collecting the result
//   - Decrementing budgetRemaining BEFORE calling this function
//   - Updating local state based on the returned action
//
// Transition priority (first match wins):
//   1. sandboxError → error
//   2. budgetRemaining <= 0 → budget-exhausted
//   3. isValidOutput=false → retry
//   4. p0p1Count == 0 → pass
//   5. p0p1Count < minP0P1Seen → continue (improvement)
//   6. p0p1Count >= minP0P1Seen → increment stale counter
//      if >= 3 → stuck, else → continue
// ---------------------------------------------------------------------------

export function shouldContinueReview(state: ReviewState): ReviewAction {
  // 1. Sandbox error — bail immediately
  if (state.sandboxError) {
    return { action: "error" };
  }

  // 2. Budget exhausted — checked before processing results
  if (state.budgetRemaining <= 0) {
    return { action: "budget-exhausted" };
  }

  // 3. Malformed output — retry, increment stale counter
  if (!state.isValidOutput) {
    const newRounds = state.roundsWithoutImprovement + 1;
    if (newRounds >= 3) {
      return { action: "stuck" };
    }
    return { action: "retry", roundsWithoutImprovement: newRounds };
  }

  // 4. Clean pass — 0 P0/P1 findings
  if (state.p0p1Count === 0) {
    return { action: "pass" };
  }

  // 5-6. Track progress against historical minimum
  if (state.p0p1Count < state.minP0P1Seen) {
    return {
      action: "continue",
      minP0P1Seen: state.p0p1Count,
      roundsWithoutImprovement: 0,
    };
  }

  // No improvement
  const newRounds = state.roundsWithoutImprovement + 1;
  if (newRounds >= 3) {
    return { action: "stuck" };
  }
  return {
    action: "continue",
    minP0P1Seen: state.minP0P1Seen,
    roundsWithoutImprovement: newRounds,
  };
}
