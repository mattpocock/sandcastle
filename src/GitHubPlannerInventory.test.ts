import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const inventory = require(
  join(import.meta.dirname, "templates", "github-planner-inventory.cjs"),
) as {
  explicitBlockerNumbers(body: string): number[];
  enrichPlannerInventory(
    issues: Array<Record<string, unknown>>,
    loadIssue: (number: number) => Record<string, unknown>,
  ): Array<Record<string, unknown>>;
};

describe("GitHub planner inventory", () => {
  const issue = (overrides: Record<string, unknown> = {}) => ({
    number: 14,
    title: "Implement the next slice",
    state: "OPEN",
    body: "## Blocked by\n\n- #12\n",
    labels: [{ name: "Sandcastle" }],
    comments: [],
    ...overrides,
  });

  it("only extracts references from explicit dependency sections", () => {
    expect(
      inventory.explicitBlockerNumbers(
        "## Parent\n\n#9\n\n## Depends on\n\n- #12 and #13\n",
      ),
    ).toEqual([12, 13]);
  });

  it("resolves blockers omitted from the open issue inventory", () => {
    const loadIssue = vi.fn((number: number) => ({
      number,
      title: "Completed prerequisite",
      state: "CLOSED",
    }));

    expect(inventory.enrichPlannerInventory([issue()], loadIssue)).toEqual([
      expect.objectContaining({
        explicitBlockersResolved: true,
        blockers: [expect.objectContaining({ number: 12, state: "CLOSED" })],
      }),
    ]);
    expect(loadIssue).toHaveBeenCalledWith(12);
  });

  it("does not reload blockers already present in the inventory", () => {
    const loadIssue = vi.fn();
    const result = inventory.enrichPlannerInventory(
      [issue(), issue({ number: 12, body: "", title: "Open prerequisite" })],
      loadIssue,
    );

    expect(result[0]).toEqual(
      expect.objectContaining({ explicitBlockersResolved: false }),
    );
    expect(loadIssue).not.toHaveBeenCalled();
  });
});
