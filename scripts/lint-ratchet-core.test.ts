import { describe, expect, it } from "vitest";
import {
  baselineGrowth,
  compare,
  countViolations,
  driftReport,
  matchObjectUndefinedCount,
  shrink,
  transfer,
  tscErrors,
} from "./lint-ratchet-core.ts";

const v = (file: string, rule: string) => ({ file, rule });

describe("lint ratchet", () => {
  it("counts violations per file and rule", () => {
    expect(
      countViolations([v("b.ts", "x"), v("a.ts", "y"), v("b.ts", "x")]),
    ).toStrictEqual({ "a.ts": { y: 1 }, "b.ts": { x: 2 } });
  });

  it("passes when the counts match the baseline", () => {
    expect(compare({ "a.ts": { x: 2 } }, { "a.ts": { x: 2 } })).toStrictEqual({
      grown: [],
      stale: [],
    });
  });

  it("fails on a count that rose", () => {
    expect(
      compare({ "a.ts": { x: 3 } }, { "a.ts": { x: 2 } }).grown,
    ).toStrictEqual(["a.ts: x 2 -> 3"]);
  });

  it("fails on a new file or a new rule", () => {
    const { grown } = compare(
      { "a.ts": { x: 1, y: 1 }, "b.ts": { x: 1 } },
      { "a.ts": { x: 1 } },
    );
    expect(grown).toStrictEqual(["a.ts: y 0 -> 1", "b.ts: x 0 -> 1"]);
  });

  it("passes on a count that fell, and lists it as below the baseline", () => {
    expect(
      compare({ "a.ts": { x: 1 } }, { "a.ts": { x: 2, y: 1 } }),
    ).toStrictEqual({
      grown: [],
      stale: ["a.ts: x 2 -> 1", "a.ts: y 1 -> 0"],
    });
  });

  it("shrinks the baseline but never raises it or adds to it", () => {
    expect(
      shrink(
        { "a.ts": { x: 5, y: 1 }, "b.ts": { x: 1 } },
        { "a.ts": { x: 2, y: 3, z: 1 } },
      ),
    ).toStrictEqual({ "a.ts": { x: 2, y: 1 } });
  });

  it("reports a baseline that grew against the base branch", () => {
    expect(
      baselineGrowth(
        { "a.ts": { x: 2 }, "b.ts": { x: 1 } },
        { "a.ts": { x: 3 } },
      ),
    ).toStrictEqual(["b.ts: x 0 -> 1"]);
  });

  it("passes a baseline grown by a transfer, and still fails a raised one", () => {
    const base = { "a.ts": { x: 4 } };
    const found = { "a.ts": { x: 1 }, "b.ts": { x: 3 } };
    const moved = transfer(found, base, new Set(["a.ts"]));
    expect(baselineGrowth(moved, base, moved)).toStrictEqual([]);
    // Raises b.ts without lowering a.ts: x's total would rise from 4 to 7.
    const raised = { "a.ts": { x: 4 }, "b.ts": { x: 3 } };
    expect(baselineGrowth(raised, base, moved)).toStrictEqual([
      "b.ts: x 0 -> 3",
    ]);
  });

  it("fails a grown baseline whose rule is not a transfer", () => {
    const base = { "a.ts": { x: 1 } };
    const found = { "a.ts": { x: 1 }, "b.ts": { x: 1 } };
    const allowed = transfer(found, base, new Set(["a.ts"]));
    expect(baselineGrowth(found, base, allowed)).toStrictEqual([
      "b.ts: x 0 -> 1",
    ]);
  });

  it("counts toMatchObject calls that give a key the value undefined", () => {
    // Built from parts so this file does not trip the check it tests.
    const call = "toMatchObject";
    const absent = "undefined";
    const source = [
      `expect(a).${call}({ k: ${absent} });`,
      `expect(b).${call}({`,
      "  nested: { k: f(1) },",
      `  other:   ${absent},`,
      "});",
      `expect(c).${call}({ k: 1 });`,
      `expect(d).toBe(${absent});`,
      `const e = { k: ${absent} };`,
    ].join("\n");
    expect(matchObjectUndefinedCount(source)).toBe(2);
  });
});

describe("tscErrors", () => {
  it("reads each error's file and code, skipping elaboration lines", () => {
    const out = [
      ".sandcastle/run.ts(3,7): error TS2345: Argument of type 'x' is not assignable.",
      "  Type 'undefined' is not assignable to type 'string'.",
      ".sandcastle/verify/lib.ts(10,1): error TS7006: Parameter 'a' implicitly has an 'any' type.",
      "",
    ].join("\n");
    expect(tscErrors(out)).toStrictEqual([
      v(".sandcastle/run.ts", "tsc/TS2345"),
      v(".sandcastle/verify/lib.ts", "tsc/TS7006"),
    ]);
  });

  it("finds nothing in clean output", () => {
    expect(tscErrors("")).toStrictEqual([]);
  });
});

describe("driftReport", () => {
  it("ranks by the live counts and shows each baseline count alongside", () => {
    const live = { "a.ts": { x: 3, y: 1 }, "b.ts": { x: 1 } };
    const baseline = { "a.ts": { x: 5, y: 1 }, "c.ts": { z: 4 } };
    expect(driftReport(live, baseline, 2).split("\n")).toStrictEqual([
      "5 / 10 violations (live / baseline), 2 / 2 files, 2 / 3 rules",
      "Top rules (live / baseline):",
      "       4 /      5  x",
      "       1 /      1  y",
      "Top files (live / baseline):",
      "       4 /      6  a.ts",
      "       1 /      0  b.ts",
    ]);
  });

  it("reports a clean tree against an empty baseline", () => {
    expect(driftReport({}, {}, 10).split("\n")).toStrictEqual([
      "0 / 0 violations (live / baseline), 0 / 0 files, 0 / 0 rules",
      "Top rules (live / baseline):",
      "Top files (live / baseline):",
    ]);
  });
});

describe("transfer", () => {
  it("carries a rule's counts from the file they left to the new file", () => {
    expect(
      transfer(
        { "a.ts": { x: 1 }, "b.ts": { x: 4 } },
        { "a.ts": { x: 5, y: 2 } },
        new Set(["a.ts"]),
      ),
    ).toStrictEqual({ "a.ts": { x: 1, y: 2 }, "b.ts": { x: 4 } });
  });

  it("carries nothing for a rule whose total rises: a new violation hidden as a transfer", () => {
    const baseline = { "a.ts": { x: 5 } };
    const found = { "a.ts": { x: 1 }, "b.ts": { x: 5 } };
    const moved = transfer(found, baseline, new Set(["a.ts"]));
    expect(moved).toStrictEqual(baseline);
    expect(compare(found, moved).grown).toStrictEqual(["b.ts: x 0 -> 5"]);
  });

  it("offsets one rule only with falls in that rule", () => {
    const baseline = { "a.ts": { x: 3, y: 3 } };
    const found = { "a.ts": { x: 3, y: 0 }, "b.ts": { x: 3 } };
    expect(transfer(found, baseline, new Set(["a.ts"]))).toStrictEqual(
      baseline,
    );
  });

  it("offsets only with falls in files the branch touches", () => {
    const baseline = { "a.ts": { x: 3 }, "stale.ts": { x: 3 } };
    const found = { "a.ts": { x: 3 }, "stale.ts": { x: 0 }, "b.ts": { x: 3 } };
    expect(transfer(found, baseline, new Set(["a.ts"]))).toStrictEqual(
      baseline,
    );
  });

  it("leaves rules with no rise alone, stale counts included", () => {
    const baseline = { "a.ts": { x: 4, y: 2 } };
    const found = { "a.ts": { x: 0, y: 1 }, "b.ts": { x: 4 } };
    expect(transfer(found, baseline, new Set(["a.ts"]))).toStrictEqual({
      "a.ts": { y: 2 },
      "b.ts": { x: 4 },
    });
  });

  it("changes nothing when nothing rose", () => {
    const baseline = { "a.ts": { x: 4 } };
    expect(
      transfer({ "a.ts": { x: 2 } }, baseline, new Set(["a.ts"])),
    ).toStrictEqual(baseline);
  });
});
