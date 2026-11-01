import { describe, expect, it } from "vitest";
import {
  baselineGrowth,
  compare,
  countViolations,
  matchObjectUndefinedCount,
  shrink,
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
