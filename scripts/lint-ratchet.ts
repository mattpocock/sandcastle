// The lint and test ratchets. Each collects violations and holds the counts,
// per file × rule, to its own baseline.
//
// The lint ratchet, scripts/lint-baseline.json:
// - oxlint (.oxlintrc.json, type-aware)               rule: `eslint(curly)`
// - Effect's language service (tsconfig.json plugin)  rule: `effect/<name>`
// - inline disable comments outside the allowlist     rule: `ratchet/disable-comment`
// - `toMatchObject({ k: undefined })` in a test        rule: `ratchet/match-object-undefined`
// - a raw git spawn in src/ that bypasses hostGit()    rule: `ratchet/raw-git-spawn`
//
// The test ratchet, scripts/test-baseline.json. New tests go in tests/ and use
// only the public API; the legacy tests elsewhere only ever leave:
// - a test file outside tests/ and the tooling tests  rule: `ratchet/test-outside-tests`
// - dependency-cruiser (.dependency-cruiser.mjs)      rule: `depcruise/<name>`
//
// Each fails when a count rises or a new file × rule appears. A count that
// falls below the baseline passes: lowering the baseline is optional in a PR,
// and .github/workflows/lint-shrink.yml opens a "shrink baseline" PR after
// each push to main. It also fails if a baseline grew against origin/main
// (where that ref exists), and if .oxlintrc.json gains an override beyond
// the three reviewed ones in scripts/lint-ratchet-config.ts.
//
//   npm run lint          both ratchets
//   npm run lint:shrink   lower the baselines to what is found (never raises
//                         them); optional, the shrink workflow does it on main
//   npm run lint:report   totals, worst rules, worst files of each baseline
//   tsx scripts/lint-ratchet.ts --init   first baselines; skips any that exist
//
// See .sandcastle/CODING_STANDARDS.md, "The lint ratchet" and "Where tests
// live".

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ENTRY_POINTS,
  TEST_FILES,
  TOOLING_SCRIPTS,
} from "./lint-ratchet-config.ts";
import type { Counts, Violation } from "./lint-ratchet-core.ts";
import {
  baselineGrowth,
  compare,
  countViolations,
  report,
  shrink,
} from "./lint-ratchet-core.ts";
import {
  ROOT,
  collectDepcruise,
  collectDirectives,
  collectEffect,
  collectLegacyTests,
  collectMatchObjectUndefined,
  collectOxlint,
  collectRawGitSpawns,
  run,
} from "./lint-ratchet-sources.ts";

interface Ratchet {
  readonly name: string;
  readonly baselinePath: string;
  readonly sources: readonly (() => Promise<Violation[]>)[];
  /** Heads the list of new violations when the ratchet fails. */
  readonly grownTitle: string;
}

const RATCHETS: readonly Ratchet[] = [
  {
    name: "lint ratchet",
    baselinePath: "scripts/lint-baseline.json",
    sources: [
      collectOxlint,
      collectEffect,
      collectDirectives,
      collectMatchObjectUndefined,
      collectRawGitSpawns,
    ],
    grownTitle:
      "New violations (file: rule baseline -> found). Fix them; never add a disable comment or raise the baseline. `npx oxlint <file>` shows where:",
  },
  {
    name: "test ratchet",
    baselinePath: "scripts/test-baseline.json",
    sources: [collectLegacyTests, collectDepcruise],
    grownTitle:
      "New test files outside tests/ or import-boundary violations (file: rule baseline -> found). Write new tests in tests/, importing only @ai-hero/sandcastle and its subpaths; `npx depcruise src tests` shows where:",
  },
];

const REPORT_LIMIT = 10;

const Baseline = z.record(z.string(), z.record(z.string(), z.number()));

const readBaseline = async (baselinePath: string): Promise<Counts> => {
  const source = await readFile(path.join(ROOT, baselinePath), "utf8");
  return Baseline.parse(JSON.parse(source));
};

const writeBaseline = async (
  baselinePath: string,
  counts: Counts,
): Promise<void> => {
  await writeFile(
    path.join(ROOT, baselinePath),
    `${JSON.stringify(counts, null, 2)}\n`,
  );
};

/** The baseline on origin/main, or undefined where it is not available. */
const readBaseBaseline = async (
  baselinePath: string,
): Promise<Counts | undefined> => {
  try {
    const out = await run("git", ["show", `origin/main:${baselinePath}`]);
    return Baseline.parse(JSON.parse(out));
  } catch {
    return undefined;
  }
};

const OxlintConfig = z.object({
  overrides: z.array(z.object({ files: z.array(z.string()) })).default([]),
});

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i]);

/** .oxlintrc.json may only loosen rules for the entry points, tests and tooling. */
const checkOverrides = async (): Promise<string[]> => {
  const source = await readFile(path.join(ROOT, ".oxlintrc.json"), "utf8");
  const config = OxlintConfig.parse(
    JSON.parse(source.replaceAll(/^\s*\/\/.*$/gmu, "")),
  );
  return config.overrides
    .filter(
      (o) =>
        ![ENTRY_POINTS, TEST_FILES, TOOLING_SCRIPTS].some((reviewed) =>
          sameList(o.files, reviewed),
        ),
    )
    .map(
      (o) =>
        `.oxlintrc.json: the override for ${o.files.join(", ")} is not one of the three reviewed ones (entry points, tests, tooling scripts). Lower the baseline instead of turning a rule off.`,
    );
};

const collect = async (ratchet: Ratchet): Promise<Counts> => {
  const sources = await Promise.all(ratchet.sources.map(async (c) => c()));
  return countViolations(sources.flat());
};

const section = (title: string, lines: readonly string[]): string =>
  lines.length === 0
    ? ""
    : `\n${title}\n${lines.map((l) => `  ${l}`).join("\n")}\n`;

const check = async (
  ratchet: Ratchet,
  found: Counts,
  baseline: Counts,
): Promise<string> => {
  const { grown } = compare(found, baseline);
  const base = await readBaseBaseline(ratchet.baselinePath);
  const growth = base === undefined ? [] : baselineGrowth(baseline, base);
  return [
    section(ratchet.grownTitle, grown),
    section(
      `${ratchet.baselinePath} grew against origin/main. It only shrinks:`,
      growth,
    ),
  ].join("");
};

const baselineExists = async (baselinePath: string): Promise<boolean> => {
  try {
    await readFile(path.join(ROOT, baselinePath), "utf8");
    return true;
  } catch {
    return false;
  }
};

/** Writes each missing first baseline. Never touches one that exists: it only shrinks. */
const initOne = async (ratchet: Ratchet): Promise<void> => {
  if (await baselineExists(ratchet.baselinePath)) {
    process.stdout.write(
      `${ratchet.baselinePath} exists, and it only shrinks; skipped.\n`,
    );
    return;
  }
  await writeBaseline(ratchet.baselinePath, await collect(ratchet));
};

const init = async (): Promise<void> => {
  await Promise.all(RATCHETS.map(async (r) => initOne(r)));
};

const printReport = async (): Promise<void> => {
  const reports = await Promise.all(
    RATCHETS.map(async (r) => {
      const counts = await readBaseline(r.baselinePath);
      return `${r.name} (${r.baselinePath}):\n${report(counts, REPORT_LIMIT)}\n`;
    }),
  );
  process.stdout.write(reports.join("\n"));
};

/** A note on counts below the baseline. They pass; the workflow lowers it. */
const belowBaseline = (found: Counts, baseline: Counts): string => {
  const { stale } = compare(found, baseline);
  return stale.length === 0
    ? ""
    : ` ${String(stale.length)} file × rule counts are below the baseline; the lint-shrink workflow lowers it after merge (or run \`npm run lint:shrink\`).`;
};

/** Runs one ratchet; resolves to its failure text, or "" when it passes. */
const verifyOne = async (
  ratchet: Ratchet,
  shrinkFirst: boolean,
): Promise<string> => {
  const found = await collect(ratchet);
  if (shrinkFirst) {
    await writeBaseline(
      ratchet.baselinePath,
      shrink(found, await readBaseline(ratchet.baselinePath)),
    );
  }
  const baseline = await readBaseline(ratchet.baselinePath);
  const problems = await check(ratchet, found, baseline);
  if (problems !== "") {
    return `${ratchet.name} failed:\n${problems}`;
  }
  const [summary] = report(found, 0).split("\n");
  process.stdout.write(
    `${ratchet.name}: ${summary ?? ""}, none new.${belowBaseline(found, baseline)}\n`,
  );
  return "";
};

const verify = async (shrinkFirst: boolean): Promise<void> => {
  const results = await Promise.all(
    RATCHETS.map(async (r) => verifyOne(r, shrinkFirst)),
  );
  const config = section("Config:", await checkOverrides());
  const failures = [
    ...results,
    config === "" ? "" : `lint ratchet failed:\n${config}`,
  ]
    .filter((f) => f !== "")
    .join("\n");
  if (failures !== "") {
    process.stderr.write(failures);
    process.exitCode = 1;
  }
};

const MODES: Readonly<Record<string, () => Promise<void>>> = {
  "--init": init,
  "--report": printReport,
  "--shrink": async () => verify(true),
};

await (MODES[process.argv[2] ?? ""] ?? (async () => verify(false)))();
