// The e2e coverage floor: the line coverage the end-to-end tests (tests/,
// the e2e vitest project) reach over src/ may only rise. The floor lives in
// scripts/coverage-baseline.json. Coverage counts the same sources as the
// deletion gate (scripts/coverage-gate.ts): the e2e tests' vitest process
// and the CLI subprocesses they spawn. The windows CI job's is not counted.
//
// It fails when coverage falls more than FLOOR_TOLERANCE (0.1 points) below
// the floor, when the floor fell against origin/main (where that ref
// exists), and when an e2e test fails: CI runs
// the e2e tests only here, so this is their test step too.
//
// Above the floor passes: raising it is optional in a PR, and
// .github/workflows/lint-shrink.yml raises it after each push to main.
//
//   npm run coverage:floor              check
//   npm run coverage:floor -- --raise   raise the floor to what is found
//                                       (never lowers it), then check
//
// See .sandcastle/CODING_STANDARDS.md, "Where tests live".

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ROOT, e2eCoverage, ensureBuild } from "./coverage-e2e.ts";
import {
  floorProblems,
  linePercent,
  pct,
  raise,
} from "./coverage-floor-core.ts";
import { total } from "./coverage-gate-core.ts";
import { run } from "./lint-ratchet-sources.ts";

const BASELINE = "scripts/coverage-baseline.json";

const Baseline = z.object({ e2e: z.object({ lines: z.number() }) });
type Baseline = z.infer<typeof Baseline>;

const readBaseline = async (): Promise<Baseline> =>
  Baseline.parse(JSON.parse(await readFile(path.join(ROOT, BASELINE), "utf8")));

/** The floor on origin/main, or undefined where it is not available. */
const readBaseFloor = async (): Promise<number | undefined> => {
  try {
    const out = await run("git", ["show", `origin/main:${BASELINE}`]);
    return Baseline.parse(JSON.parse(out)).e2e.lines;
  } catch {
    return undefined;
  }
};

const main = async (): Promise<void> => {
  const raising = process.argv[2] === "--raise";
  await ensureBuild();
  const e2e = await e2eCoverage();
  const found = linePercent(e2e.lines, e2e.coverable);
  if (raising) {
    const { e2e: current } = await readBaseline();
    const next: Baseline = { e2e: { lines: raise(found, current.lines) } };
    await writeFile(
      path.join(ROOT, BASELINE),
      `${JSON.stringify(next, null, 2)}\n`,
    );
  }
  const { e2e: baseline } = await readBaseline();
  const floor = baseline.lines;
  const problems = [
    ...floorProblems({ found, floor, baseFloor: await readBaseFloor() }),
    ...(e2e.passed ? [] : ["An e2e test failed; its output is above."]),
  ];
  process.stdout.write(
    `e2e coverage floor: ${pct(found)} of ${String(total(e2e.coverable))} src/ lines, floor ${pct(floor)}.\n${e2e.sources.map((s) => `  ${s}\n`).join("")}`,
  );
  if (problems.length > 0) {
    process.stderr.write(
      `e2e coverage floor failed:\n${problems.map((p) => `  ${p}\n`).join("")}`,
    );
    process.exitCode = 1;
  }
};

await main();
