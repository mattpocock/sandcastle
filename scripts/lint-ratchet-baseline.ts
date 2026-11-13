// The ratchets' baselines on disk: reading and writing the checked-in file,
// and reading the one on origin/main for the "baseline grew" check.
// scripts/lint-ratchet.ts holds the counts to them.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Counts } from "./lint-ratchet-core.ts";
import { ROOT, run } from "./lint-ratchet-sources.ts";

const Baseline = z.record(z.string(), z.record(z.string(), z.number()));

export const readBaseline = async (baselinePath: string): Promise<Counts> => {
  const source = await readFile(path.join(ROOT, baselinePath), "utf8");
  return Baseline.parse(JSON.parse(source));
};

export const writeBaseline = async (
  baselinePath: string,
  counts: Counts,
): Promise<void> => {
  await writeFile(
    path.join(ROOT, baselinePath),
    `${JSON.stringify(counts, null, 2)}\n`,
  );
};

/**
 * What the "baseline grew against origin/main" check does when it cannot read
 * a baseline from origin/main: locally it skips (a clone may lack the ref), but
 * in CI it fails, so a checkout that drops the ref cannot switch the check off
 * unseen. Resolves to the failure text, or undefined to skip.
 */
export const missingBaseBaseline = (
  baselinePath: string,
  ci: string | undefined,
): string | undefined =>
  ci === "true"
    ? `Cannot read origin/main:${baselinePath}, so the "grew against origin/main" check cannot run. CI must check out with origin/main (\`fetch-depth: 0\` on actions/checkout, see .github/workflows/ci.yml).`
    : undefined;

/** The baseline on origin/main, or undefined where it is not available. In CI it must be: see missingBaseBaseline. */
export const readBaseBaseline = async (
  baselinePath: string,
): Promise<Counts | undefined> => {
  try {
    const out = await run("git", ["show", `origin/main:${baselinePath}`]);
    return Baseline.parse(JSON.parse(out));
  } catch (error) {
    const missing = missingBaseBaseline(baselinePath, process.env["CI"]);
    if (missing !== undefined) {
      throw new Error(missing, { cause: error });
    }
    return undefined;
  }
};

export const baselineExists = async (
  baselinePath: string,
): Promise<boolean> => {
  try {
    await readFile(path.join(ROOT, baselinePath), "utf8");
    return true;
  } catch {
    return false;
  }
};
