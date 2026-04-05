import { describe, expect, it } from "vitest";
import {
  parseXmlTag,
  validateDiscovery,
  validateReview,
  filterAndSort,
  validateBranchName,
  shouldContinueReview,
} from "./helpers.js";
import type { DiscoveryItem, ReviewState } from "./helpers.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<DiscoveryItem> = {}): DiscoveryItem {
  return {
    id: "item-1",
    title: "Fix the thing",
    tier: "issue",
    score: 80,
    size: "trivial",
    description: "A small fix",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseXmlTag
// ---------------------------------------------------------------------------

describe("parseXmlTag", () => {
  it("parses valid XML tag with valid JSON", () => {
    const input = '<result>{"key":"value"}</result>';
    const result = parseXmlTag<{ key: string }>(input, "result");
    expect(result).toEqual({ key: "value" });
  });

  it("parses tag with multiline JSON content", () => {
    const input = `<data>
{
  "name": "test",
  "count": 42
}
</data>`;
    const result = parseXmlTag<{ name: string; count: number }>(input, "data");
    expect(result).toEqual({ name: "test", count: 42 });
  });

  it("returns null when no matching tag exists", () => {
    const input = '<other>{"key":"value"}</other>';
    expect(parseXmlTag(input, "result")).toBeNull();
  });

  it("returns null when matching tag contains invalid JSON", () => {
    const input = "<result>not json at all</result>";
    expect(parseXmlTag(input, "result")).toBeNull();
  });

  it("returns null for empty string input", () => {
    expect(parseXmlTag("", "result")).toBeNull();
  });

  it("returns first match when multiple matching tags exist", () => {
    const input = '<tag>{"n":1}</tag> some text <tag>{"n":2}</tag>';
    const result = parseXmlTag<{ n: number }>(input, "tag");
    expect(result).toEqual({ n: 1 });
  });

  it("parses correctly when JSON values contain nested XML-like content", () => {
    const input = '<result>{"html":"<b>bold</b>"}</result>';
    const result = parseXmlTag<{ html: string }>(input, "result");
    expect(result).toEqual({ html: "<b>bold</b>" });
  });
});

// ---------------------------------------------------------------------------
// validateDiscovery
// ---------------------------------------------------------------------------

describe("validateDiscovery", () => {
  it("returns true for valid discovery with all required fields", () => {
    const obj = { items: [makeItem()] };
    expect(validateDiscovery(obj)).toBe(true);
    expect(obj.items).toHaveLength(1);
  });

  it("returns true and filters out invalid items from mixed array", () => {
    const valid = makeItem({ id: "good" });
    const obj = { items: [valid, { bad: true }, null, 42] };
    expect(validateDiscovery(obj)).toBe(true);
    expect(obj.items).toHaveLength(1);
    expect((obj.items as DiscoveryItem[])[0]!.id).toBe("good");
  });

  it("returns false for null input", () => {
    expect(validateDiscovery(null)).toBe(false);
  });

  it("returns false for string input", () => {
    expect(validateDiscovery("hello")).toBe(false);
  });

  it("returns false for number input", () => {
    expect(validateDiscovery(123)).toBe(false);
  });

  it("returns false for object without items array", () => {
    expect(validateDiscovery({ stuff: [] })).toBe(false);
  });

  it("returns true for empty items array", () => {
    const obj = { items: [] };
    expect(validateDiscovery(obj)).toBe(true);
    expect(obj.items).toHaveLength(0);
  });

  it("filters out item with empty string id", () => {
    const obj = { items: [makeItem({ id: "" })] };
    expect(validateDiscovery(obj)).toBe(true);
    expect(obj.items).toHaveLength(0);
  });

  it("filters out item with NaN score", () => {
    const obj = { items: [makeItem({ score: NaN })] };
    expect(validateDiscovery(obj)).toBe(true);
    expect(obj.items).toHaveLength(0);
  });

  it("filters out item with Infinity score", () => {
    const obj = { items: [makeItem({ score: Infinity })] };
    expect(validateDiscovery(obj)).toBe(true);
    expect(obj.items).toHaveLength(0);
  });

  it("filters out item missing tier field", () => {
    const { tier: _, ...noTier } = makeItem();
    const obj = { items: [noTier] };
    expect(validateDiscovery(obj)).toBe(true);
    expect(obj.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateReview
// ---------------------------------------------------------------------------

describe("validateReview", () => {
  it("returns true for valid review with pass=true and all severity counts", () => {
    const review = {
      pass: true,
      findings_summary: { p0: 0, p1: 0, p2: 1, p3: 3 },
      details: [],
    };
    expect(validateReview(review)).toBe(true);
  });

  it("returns true for valid review with pass=false", () => {
    const review = {
      pass: false,
      findings_summary: { p0: 2, p1: 1, p2: 0, p3: 0 },
      details: [],
    };
    expect(validateReview(review)).toBe(true);
  });

  it("returns false for null input", () => {
    expect(validateReview(null)).toBe(false);
  });

  it("returns false when pass field is missing", () => {
    expect(
      validateReview({ findings_summary: { p0: 0, p1: 0 }, details: [] }),
    ).toBe(false);
  });

  it('returns false when pass is string "true" instead of boolean', () => {
    expect(
      validateReview({
        pass: "true",
        findings_summary: { p0: 0, p1: 0 },
        details: [],
      }),
    ).toBe(false);
  });

  it("returns false when findings_summary is missing", () => {
    expect(validateReview({ pass: true, details: [] })).toBe(false);
  });

  it("returns false when findings_summary.p0 is NaN", () => {
    expect(
      validateReview({
        pass: true,
        findings_summary: { p0: NaN, p1: 0 },
        details: [],
      }),
    ).toBe(false);
  });

  it("returns true when findings_summary has p0 and p1 but missing p2/p3", () => {
    expect(
      validateReview({
        pass: true,
        findings_summary: { p0: 0, p1: 0 },
        details: [],
      }),
    ).toBe(true);
  });

  it("returns false when findings_summary.p1 is NaN", () => {
    expect(
      validateReview({
        pass: true,
        findings_summary: { p0: 0, p1: NaN },
        details: [],
      }),
    ).toBe(false);
  });

  it("returns false for undefined input", () => {
    expect(validateReview(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterAndSort (cross-tier mode)
// ---------------------------------------------------------------------------

describe("filterAndSort", () => {
  const crossTierConfig = {
    priorityMode: "cross-tier" as const,
    maxFilesPerIdea: 10,
  };
  const tierOrderedConfig = {
    priorityMode: "tier-ordered" as const,
    maxFilesPerIdea: 10,
  };

  describe("cross-tier mode", () => {
    it("sorts items by score descending regardless of tier", () => {
      const items = [
        makeItem({ id: "a", tier: "ideation", score: 50, viability: true }),
        makeItem({ id: "b", tier: "issue", score: 90 }),
        makeItem({ id: "c", tier: "todo", score: 70 }),
      ];
      const result = filterAndSort(items, crossTierConfig);
      expect(result.map((i) => i.id)).toEqual(["b", "c", "a"]);
    });

    it("filters out ideation items with viability=false", () => {
      const items = [
        makeItem({ id: "a", tier: "ideation", score: 90, viability: false }),
        makeItem({ id: "b", tier: "issue", score: 50 }),
      ];
      const result = filterAndSort(items, crossTierConfig);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("b");
    });

    it("filters out ideation items where files_affected exceeds maxFilesPerIdea", () => {
      const items = [
        makeItem({
          id: "a",
          tier: "ideation",
          score: 90,
          viability: true,
          files_affected: 15,
        }),
        makeItem({ id: "b", tier: "issue", score: 50 }),
      ];
      const result = filterAndSort(items, crossTierConfig);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("b");
    });

    it("returns empty array for empty input", () => {
      expect(filterAndSort([], crossTierConfig)).toEqual([]);
    });

    it("keeps ideation item with viability=true and files within limit", () => {
      const items = [
        makeItem({
          id: "a",
          tier: "ideation",
          score: 80,
          viability: true,
          files_affected: 5,
        }),
      ];
      const result = filterAndSort(items, crossTierConfig);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("a");
    });

    it("keeps ideation item with viability=undefined (not set)", () => {
      const items = [makeItem({ id: "a", tier: "ideation", score: 80 })];
      const result = filterAndSort(items, crossTierConfig);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("a");
    });

    it("keeps ideation item when files_affected equals maxFilesPerIdea exactly", () => {
      const items = [
        makeItem({
          id: "a",
          tier: "ideation",
          score: 80,
          viability: true,
          files_affected: 10,
        }),
      ];
      const result = filterAndSort(items, crossTierConfig);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("a");
    });

    it("never filters non-ideation items by viability or files_affected", () => {
      const items = [
        makeItem({
          id: "a",
          tier: "issue",
          score: 80,
          viability: false,
          files_affected: 100,
        }),
        makeItem({
          id: "b",
          tier: "todo",
          score: 70,
          viability: false,
          files_affected: 50,
        }),
        makeItem({
          id: "c",
          tier: "optimization",
          score: 60,
          viability: false,
          files_affected: 200,
        }),
      ];
      const result = filterAndSort(items, crossTierConfig);
      expect(result).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // filterAndSort (tier-ordered mode)
  // ---------------------------------------------------------------------------

  describe("tier-ordered mode", () => {
    it("groups items by tier in order and sorts by score within each tier", () => {
      const items = [
        makeItem({ id: "opt-1", tier: "optimization", score: 60 }),
        makeItem({ id: "issue-1", tier: "issue", score: 70 }),
        makeItem({ id: "todo-1", tier: "todo", score: 50 }),
        makeItem({ id: "issue-2", tier: "issue", score: 90 }),
        makeItem({
          id: "idea-1",
          tier: "ideation",
          score: 80,
          viability: true,
        }),
        makeItem({ id: "todo-2", tier: "todo", score: 85 }),
      ];
      const result = filterAndSort(items, tierOrderedConfig);
      expect(result.map((i) => i.id)).toEqual([
        "issue-2",
        "issue-1",
        "todo-2",
        "todo-1",
        "opt-1",
        "idea-1",
      ]);
    });

    it("applies same filtering rules as cross-tier mode", () => {
      const items = [
        makeItem({ id: "a", tier: "ideation", score: 90, viability: false }),
        makeItem({
          id: "b",
          tier: "ideation",
          score: 80,
          viability: true,
          files_affected: 15,
        }),
        makeItem({ id: "c", tier: "issue", score: 50 }),
        makeItem({
          id: "d",
          tier: "ideation",
          score: 70,
          viability: true,
          files_affected: 5,
        }),
      ];
      const result = filterAndSort(items, tierOrderedConfig);
      expect(result.map((i) => i.id)).toEqual(["c", "d"]);
    });

    it("handles missing tiers without errors", () => {
      const items = [
        makeItem({ id: "a", tier: "issue", score: 90 }),
        makeItem({ id: "b", tier: "ideation", score: 80, viability: true }),
      ];
      const result = filterAndSort(items, tierOrderedConfig);
      expect(result.map((i) => i.id)).toEqual(["a", "b"]);
    });
  });
});

// ---------------------------------------------------------------------------
// validateBranchName
// ---------------------------------------------------------------------------

describe("validateBranchName", () => {
  it("accepts valid branch names with alphanumeric, dots, slashes, and hyphens", () => {
    expect(() => validateBranchName("feature/add-login")).not.toThrow();
    expect(() => validateBranchName("release/v1.2.3")).not.toThrow();
    expect(() => validateBranchName("main")).not.toThrow();
    expect(() => validateBranchName("fix/issue-42/retry")).not.toThrow();
  });

  it("throws for branch name with spaces", () => {
    expect(() => validateBranchName("my branch")).toThrow(
      "Invalid branch name",
    );
  });

  it("throws for branch name with colons", () => {
    expect(() => validateBranchName("feature:thing")).toThrow(
      "Invalid branch name",
    );
  });

  it("throws for branch name with special characters", () => {
    expect(() => validateBranchName("feature@thing")).toThrow(
      "Invalid branch name",
    );
    expect(() => validateBranchName("feature#thing")).toThrow(
      "Invalid branch name",
    );
  });

  it("throws for empty string", () => {
    expect(() => validateBranchName("")).toThrow("Invalid branch name");
  });

  it("throws for shell injection characters", () => {
    expect(() => validateBranchName("main; rm -rf /")).toThrow(
      "Invalid branch name",
    );
    expect(() => validateBranchName("feat`whoami`")).toThrow(
      "Invalid branch name",
    );
    expect(() => validateBranchName("feat$(id)")).toThrow(
      "Invalid branch name",
    );
  });
});

// ---------------------------------------------------------------------------
// shouldContinueReview — stuck detection state machine
// ---------------------------------------------------------------------------

describe("shouldContinueReview", () => {
  /** Base state with sane defaults — override per test */
  function state(overrides: Partial<ReviewState> = {}): ReviewState {
    return {
      p0p1Count: 0,
      minP0P1Seen: Infinity,
      roundsWithoutImprovement: 0,
      budgetRemaining: 10,
      isValidOutput: true,
      sandboxError: false,
      ...overrides,
    };
  }

  // --- Happy path ---

  it("returns pass when p0p1Count is 0", () => {
    const result = shouldContinueReview(state({ p0p1Count: 0 }));
    expect(result.action).toBe("pass");
  });

  // --- Convergence ---

  it("converges through improving rounds to pass", () => {
    // Round 1: count=3, minSeen=Infinity → continue, minSeen=3
    const r1 = shouldContinueReview(
      state({
        p0p1Count: 3,
        minP0P1Seen: Infinity,
        roundsWithoutImprovement: 0,
      }),
    );
    expect(r1.action).toBe("continue");
    expect(r1).toHaveProperty("minP0P1Seen", 3);
    expect(r1).toHaveProperty("roundsWithoutImprovement", 0);

    // Round 2: count=1, minSeen=3 → continue, minSeen=1
    const r2 = shouldContinueReview(
      state({ p0p1Count: 1, minP0P1Seen: 3, roundsWithoutImprovement: 0 }),
    );
    expect(r2.action).toBe("continue");
    expect(r2).toHaveProperty("minP0P1Seen", 1);

    // Round 3: count=0 → pass
    const r3 = shouldContinueReview(
      state({ p0p1Count: 0, minP0P1Seen: 1, roundsWithoutImprovement: 0 }),
    );
    expect(r3.action).toBe("pass");
  });

  // --- Stuck (flat count) ---

  it("detects stuck after 3 rounds of flat count", () => {
    // Round 1: count=2, min=Infinity → continue, min=2, stale=0
    const r1 = shouldContinueReview(
      state({ p0p1Count: 2, minP0P1Seen: Infinity }),
    );
    expect(r1.action).toBe("continue");

    // Round 2: count=2, min=2 → stale=1
    const r2 = shouldContinueReview(
      state({ p0p1Count: 2, minP0P1Seen: 2, roundsWithoutImprovement: 0 }),
    );
    expect(r2.action).toBe("continue");
    expect(r2).toHaveProperty("roundsWithoutImprovement", 1);

    // Round 3: count=2, min=2 → stale=2
    const r3 = shouldContinueReview(
      state({ p0p1Count: 2, minP0P1Seen: 2, roundsWithoutImprovement: 1 }),
    );
    expect(r3.action).toBe("continue");
    expect(r3).toHaveProperty("roundsWithoutImprovement", 2);

    // Round 4: count=2, min=2 → stale=3 → stuck
    const r4 = shouldContinueReview(
      state({ p0p1Count: 2, minP0P1Seen: 2, roundsWithoutImprovement: 2 }),
    );
    expect(r4.action).toBe("stuck");
  });

  // --- Stuck (oscillation) ---

  it("detects stuck when count oscillates without improving on minimum", () => {
    // Round 1: count=3, min=Infinity → continue, min=3
    // Round 2: count=2, min=3 → continue, min=2, stale=0
    // Round 3: count=3, min=2 → stale=1
    // Round 4: count=3, min=2 → stale=2
    // Round 5: count=3, min=2 → stale=3 → stuck
    const r5 = shouldContinueReview(
      state({ p0p1Count: 3, minP0P1Seen: 2, roundsWithoutImprovement: 2 }),
    );
    expect(r5.action).toBe("stuck");
  });

  // --- Stuck (fix-introduce-regress) ---

  it("detects stuck when count stays flat even with different issues", () => {
    // Same as flat count — the function only sees the number, not which issues
    const r4 = shouldContinueReview(
      state({ p0p1Count: 2, minP0P1Seen: 2, roundsWithoutImprovement: 2 }),
    );
    expect(r4.action).toBe("stuck");
  });

  // --- Budget exhaustion ---

  it("returns budget-exhausted when budgetRemaining is 0", () => {
    const result = shouldContinueReview(
      state({ budgetRemaining: 0, p0p1Count: 3 }),
    );
    expect(result.action).toBe("budget-exhausted");
  });

  it("returns budget-exhausted when budgetRemaining is negative", () => {
    const result = shouldContinueReview(
      state({ budgetRemaining: -1, p0p1Count: 3 }),
    );
    expect(result.action).toBe("budget-exhausted");
  });

  // --- Sandbox error ---

  it("returns error on sandbox error (immediate bail)", () => {
    const result = shouldContinueReview(
      state({ sandboxError: true, p0p1Count: 3 }),
    );
    expect(result.action).toBe("error");
  });

  // --- Malformed output ---

  it("returns retry on invalid output and increments stale counter", () => {
    const result = shouldContinueReview(
      state({ isValidOutput: false, roundsWithoutImprovement: 0 }),
    );
    expect(result.action).toBe("retry");
    expect(result).toHaveProperty("roundsWithoutImprovement", 1);
  });

  it("returns stuck after 3 consecutive invalid outputs", () => {
    const result = shouldContinueReview(
      state({ isValidOutput: false, roundsWithoutImprovement: 2 }),
    );
    expect(result.action).toBe("stuck");
  });

  // --- Budget ordering ---

  it("returns pass when budget=0 and p0p1Count=0 (pass checked before budget)", () => {
    const result = shouldContinueReview(
      state({ budgetRemaining: 0, p0p1Count: 0 }),
    );
    expect(result.action).toBe("pass");
  });

  it("returns error when sandboxError=true even if budget=0 (sandbox error checked first)", () => {
    // This state is unreachable in actual reviewLoop but tests pure function priority
    const result = shouldContinueReview(
      state({ sandboxError: true, budgetRemaining: 0 }),
    );
    expect(result.action).toBe("error");
  });

  // --- Edge cases ---

  it("improvement resets the stale counter", () => {
    // After 2 stale rounds at min=3, count improves to 2 → resets
    const r = shouldContinueReview(
      state({ p0p1Count: 2, minP0P1Seen: 3, roundsWithoutImprovement: 2 }),
    );
    expect(r.action).toBe("continue");
    expect(r).toHaveProperty("minP0P1Seen", 2);
    expect(r).toHaveProperty("roundsWithoutImprovement", 0);
  });

  it("detects stuck with improvement-then-stale pattern [5,3,3,2,2,2,2]", () => {
    // After round 4: min=2, stale=0
    // Round 5: count=2, min=2 → stale=1
    // Round 6: count=2, min=2 → stale=2
    // Round 7: count=2, min=2 → stale=3 → stuck
    const r7 = shouldContinueReview(
      state({ p0p1Count: 2, minP0P1Seen: 2, roundsWithoutImprovement: 2 }),
    );
    expect(r7.action).toBe("stuck");
  });

  it("detects stuck when single finding never resolves [1,1,1,1]", () => {
    // Round 1: min=1, stale=0. Round 2: stale=1. Round 3: stale=2. Round 4: stale=3 → stuck
    const r4 = shouldContinueReview(
      state({ p0p1Count: 1, minP0P1Seen: 1, roundsWithoutImprovement: 2 }),
    );
    expect(r4.action).toBe("stuck");
  });

  it("passes when large count improves steadily to 0", () => {
    // Simulate: counts [10, 8, 5, 3, 1, 0]
    // Each round improves on min, so stale never increments
    // Round 6: count=0 → pass
    const r6 = shouldContinueReview(
      state({ p0p1Count: 0, minP0P1Seen: 1, roundsWithoutImprovement: 0 }),
    );
    expect(r6.action).toBe("pass");
  });
});
