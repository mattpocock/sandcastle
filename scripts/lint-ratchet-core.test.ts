import { describe, expect, it } from "vitest";
import {
  baselineGrowth,
  compare,
  countViolations,
  shrink,
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
});
