// The pure half of scripts/coverage-floor.ts: line coverage as a percentage,
// and holding it to the floor in scripts/coverage-baseline.json.

import type { Lines } from "./coverage-gate-core.ts";
import { total } from "./coverage-gate-core.ts";

/** The covered share of `coverable`, in percent. Lines outside it don't count. */
export const linePercent = (covered: Lines, coverable: Lines): number => {
  const all = total(coverable);
  if (all === 0) {
    return 0;
  }
  const hit = [...coverable].reduce(
    (sum, [file, lines]) =>
      sum + [...lines].filter((l) => covered.get(file)?.has(l) === true).length,
    0,
  );
  return (hit / all) * 100;
};

/** `percent` rounded down to two decimals: the floor it sets. */
export const floorOf = (percent: number): number =>
  Math.floor(percent * 100 + 1e-9) / 100;

/**
 * How far below the floor coverage may measure and still pass, in percentage
 * points. The same commit measures slightly differently per platform (53.81%
 * on CI's Linux, 53.80% locally) because V8 and the source maps map a few
 * lines differently, so a floor raised on one machine must not fail another.
 */
export const FLOOR_TOLERANCE = 0.1;

/** `percent` rounded down to one decimal: the floor `--raise` stores. */
const raisedFloorOf = (percent: number): number =>
  Math.floor(percent * 10 + 1e-9) / 10;

/** The floor raised to `found`, rounded down to one decimal. Never lowers it. */
export const raise = (found: number, floor: number): number =>
  Math.max(floor, raisedFloorOf(found));

/** Rounded down, like the floor, so a value just under it never prints equal. */
export const pct = (n: number): string => `${floorOf(n).toFixed(2)}%`;

/** What the floor check weighs. */
export interface FloorInput {
  /** Line coverage the e2e tests reach now, in percent. */
  readonly found: number;
  /** The floor in this checkout's baseline. */
  readonly floor: number;
  /** The floor on origin/main, where that ref exists. */
  readonly baseFloor: number | undefined;
}

/** Why the check fails; empty when it passes. */
export const floorProblems = ({
  found,
  floor,
  baseFloor,
}: FloorInput): string[] => [
  ...(found + FLOOR_TOLERANCE < floor - 1e-9
    ? [
        `e2e line coverage fell to ${pct(found)}, more than ${FLOOR_TOLERANCE.toFixed(1)} points below the floor of ${pct(floor)}. Cover the new or changed code from tests/ (through the public API); never lower the floor.`,
      ]
    : []),
  ...(baseFloor !== undefined && floor < baseFloor
    ? [
        `scripts/coverage-baseline.json lowered the floor from ${pct(baseFloor)} on origin/main to ${pct(floor)}. It only rises.`,
      ]
    : []),
];
