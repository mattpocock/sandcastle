import { describe, expect, it } from "vitest";
import type { Lines } from "./coverage-gate-core.ts";
import {
  FLOOR_TOLERANCE,
  floorOf,
  floorProblems,
  linePercent,
  raise,
} from "./coverage-floor-core.ts";

const lines = (entries: Record<string, readonly number[]>): Lines =>
  new Map(Object.entries(entries).map(([file, l]) => [file, new Set(l)]));

describe("linePercent", () => {
  it("is the covered share of the coverable lines", () => {
    expect(
      linePercent(
        lines({ "src/a.ts": [1, 2], "src/b.ts": [5] }),
        lines({ "src/a.ts": [1, 2, 3, 4], "src/b.ts": [5, 6, 7, 8] }),
      ),
    ).toBe(37.5);
  });

  it("ignores covered lines that are not coverable", () => {
    expect(
      linePercent(
        lines({ "src/a.ts": [1, 99], "src/other.ts": [1] }),
        lines({ "src/a.ts": [1, 2] }),
      ),
    ).toBe(50);
  });

  it("is 0 when nothing is coverable", () => {
    expect(linePercent(lines({}), lines({}))).toBe(0);
  });
});

describe("floorOf and raise", () => {
  it("rounds down to two decimals", () => {
    expect(floorOf((4017 / 11_588) * 100)).toBe(34.66);
    expect(floorOf(34.66)).toBe(34.66);
  });

  it("raises the floor, rounded down to one decimal, but never lowers it", () => {
    expect(raise(40.129, 34.66)).toBe(40.1);
    expect(raise(53.81, 34.66)).toBe(53.8);
    expect(raise(30, 34.66)).toBe(34.66);
  });
});

describe("floorProblems", () => {
  it("passes at or above the floor", () => {
    expect(
      floorProblems({ found: 34.66, floor: 34.66, baseFloor: 34.66 }),
    ).toStrictEqual([]);
  });

  it("passes within the tolerance below the floor", () => {
    expect(FLOOR_TOLERANCE).toBe(0.1);
    expect(
      floorProblems({ found: 53.7, floor: 53.8, baseFloor: 53.8 }),
    ).toStrictEqual([]);
    expect(
      floorProblems({ found: 53.75, floor: 53.8, baseFloor: undefined }),
    ).toStrictEqual([]);
  });

  it("fails more than the tolerance below the floor", () => {
    expect(
      floorProblems({ found: 34.55, floor: 34.66, baseFloor: undefined }),
    ).toStrictEqual([
      "e2e line coverage fell to 34.55%, more than 0.1 points below the floor of 34.66%. Cover the new or changed code from tests/ (through the public API); never lower the floor.",
    ]);
  });

  it("fails when the floor was lowered against origin/main", () => {
    expect(
      floorProblems({ found: 40, floor: 30, baseFloor: 34.66 }),
    ).toStrictEqual([
      "scripts/coverage-baseline.json lowered the floor from 34.66% on origin/main to 30.00%. It only rises.",
    ]);
  });
});
