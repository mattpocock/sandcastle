import { describe, expect, it } from "vitest";
import { validatePlannerBatch } from "./templates/planner-batch.js";

const inventory = [
  {
    number: 20,
    title: "Run bounded provider-backed portfolios",
    explicitBlockersResolved: true,
  },
  {
    number: 22,
    title: "Create and monitor a portfolio run from the website",
    explicitBlockersResolved: true,
  },
];

const selected = (id: string, likelyAreas: string[]) => ({
  id,
  disposition: "selected" as const,
  reason: "Independent implementation slice",
  likelyAreas,
});

describe("planner batch validation", () => {
  it("rejects an eligible candidate silently omitted from the batch", () => {
    expect(() =>
      validatePlannerBatch(inventory, {
        issues: [{ id: "22", title: "Web", branch: "sandcastle/issue-22" }],
        decisions: [selected("22", ["apps/web"])],
      }),
    ).toThrow("missing decisions for: 20");
  });

  it("rejects a false explicit-blocker disposition", () => {
    expect(() =>
      validatePlannerBatch(inventory, {
        issues: [{ id: "22", title: "Web", branch: "sandcastle/issue-22" }],
        decisions: [
          {
            id: "20",
            disposition: "blocked" as const,
            reason: "Prerequisite is unresolved",
            likelyAreas: ["apps/market-discovery"],
          },
          selected("22", ["apps/web"]),
        ],
      }),
    ).toThrow("20 is marked blocked but its explicit blockers are resolved");
  });

  it("rejects selecting a candidate with unresolved explicit blockers", () => {
    expect(() =>
      validatePlannerBatch([{ number: 24, explicitBlockersResolved: false }], {
        issues: [
          { id: "24", title: "Blocked UI", branch: "sandcastle/issue-24" },
        ],
        decisions: [selected("24", ["apps/web"])],
      }),
    ).toThrow("24 has unresolved explicit blockers and must be blocked");
  });

  it("rejects a claimed conflict without a shared material area", () => {
    expect(() =>
      validatePlannerBatch(inventory, {
        issues: [{ id: "22", title: "Web", branch: "sandcastle/issue-22" }],
        decisions: [
          {
            id: "20",
            disposition: "parallel-conflict" as const,
            reason: "Both concern portfolio runs",
            likelyAreas: ["apps/market-discovery", "README.md"],
            conflictsWith: ["22"],
          },
          selected("22", ["apps/web", "README.md"]),
        ],
      }),
    ).toThrow("20 has no shared material area with selected conflict 22");
  });

  it("accepts the #20 and #22 parallel batch", () => {
    expect(
      validatePlannerBatch(inventory, {
        issues: [
          { id: "20", title: "Backend", branch: "sandcastle/issue-20" },
          { id: "22", title: "Web", branch: "sandcastle/issue-22" },
        ],
        decisions: [
          selected("20", ["apps/market-discovery"]),
          selected("22", ["apps/web"]),
        ],
      }),
    ).toBeUndefined();
  });
});
