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

/** The floor raised to `found`. Never lowers it. */
export const raise = (found: number, floor: number): number =>
  Math.max(floor, floorOf(found));

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
  ...(found < floor
    ? [
        `e2e line coverage fell to ${pct(found)}, below the floor of ${pct(floor)}. Cover the new or changed code from tests/ (through the public API); never lower the floor.`,
      ]
    : []),
  ...(baseFloor !== undefined && floor < baseFloor
    ? [
        `scripts/coverage-baseline.json lowered the floor from ${pct(baseFloor)} on origin/main to ${pct(floor)}. It only rises.`,
      ]
    : []),
];
