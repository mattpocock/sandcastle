// The lint ratchet. Collects every violation from three sources and holds the
// counts, per file × rule, to scripts/lint-baseline.json:
//
// - oxlint (.oxlintrc.json, type-aware)               rule: `eslint(curly)`
// - Effect's language service (tsconfig.json plugin)  rule: `effect/<name>`
// - inline disable comments outside the allowlist     rule: `ratchet/disable-comment`
//
// It fails when a count rises or a new file × rule appears. A count that falls
// below the baseline passes: lowering the baseline is optional in a PR, and
// .github/workflows/lint-shrink.yml opens a "shrink baseline" PR after each
// push to main. It also fails if the baseline grew against origin/main
// (where that ref exists), and if .oxlintrc.json gains an override beyond
// the two reviewed ones in scripts/lint-ratchet-config.ts.
//
//   npm run lint          oxlint, Effect diagnostics, then this check
//   npm run lint:shrink   lower the baseline to what is found (never raises it);
//                         optional, the shrink-baseline workflow does it on main
//   npm run lint:report   totals, worst rules, worst files of the baseline
//   tsx scripts/lint-ratchet.ts --init   first baseline; refuses once one exists
//
// See .sandcastle/CODING_STANDARDS.md, "The lint ratchet".

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ENTRY_POINTS, TEST_FILES } from "./lint-ratchet-config.ts";
import type { Counts } from "./lint-ratchet-core.ts";
import {
  baselineGrowth,
  compare,
  countViolations,
  report,
  shrink,
} from "./lint-ratchet-core.ts";
import {
  ROOT,
  collectDirectives,
  collectEffect,
  collectOxlint,
  run,
} from "./lint-ratchet-sources.ts";

const BASELINE_PATH = "scripts/lint-baseline.json";
const REPORT_LIMIT = 10;

const Baseline = z.record(z.string(), z.record(z.string(), z.number()));

const readBaseline = async (): Promise<Counts> => {
  const source = await readFile(path.join(ROOT, BASELINE_PATH), "utf8");
  return Baseline.parse(JSON.parse(source));
};

const writeBaseline = async (counts: Counts): Promise<void> => {
  await writeFile(
    path.join(ROOT, BASELINE_PATH),
    `${JSON.stringify(counts, null, 2)}\n`,
  );
};

/** The baseline on origin/main, or undefined where it is not available. */
const readBaseBaseline = async (): Promise<Counts | undefined> => {
  try {
    const out = await run("git", ["show", `origin/main:${BASELINE_PATH}`]);
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

/** .oxlintrc.json may only loosen rules for the entry points and tests. */
const checkOverrides = async (): Promise<string[]> => {
  const source = await readFile(path.join(ROOT, ".oxlintrc.json"), "utf8");
  const config = OxlintConfig.parse(
    JSON.parse(source.replaceAll(/^\s*\/\/.*$/gmu, "")),
  );
  return config.overrides
    .filter(
      (o) => !sameList(o.files, ENTRY_POINTS) && !sameList(o.files, TEST_FILES),
    )
    .map(
      (o) =>
        `.oxlintrc.json: the override for ${o.files.join(", ")} is not one of the two reviewed ones (entry points, tests). Lower the baseline instead of turning a rule off.`,
    );
};

const collect = async (): Promise<Counts> => {
  const sources = await Promise.all([
    collectOxlint(),
    collectEffect(),
    collectDirectives(),
  ]);
  return countViolations(sources.flat());
};

const section = (title: string, lines: readonly string[]): string =>
  lines.length === 0
    ? ""
    : `\n${title}\n${lines.map((l) => `  ${l}`).join("\n")}\n`;

const check = async (found: Counts, baseline: Counts): Promise<string> => {
  const { grown } = compare(found, baseline);
  const base = await readBaseBaseline();
  const growth = base === undefined ? [] : baselineGrowth(baseline, base);
  const config = await checkOverrides();
  return [
    section(
      "New violations (file: rule baseline -> found). Fix them; never add a disable comment or raise the baseline. `npx oxlint <file>` shows where:",
      grown,
    ),
    section(
      `${BASELINE_PATH} grew against origin/main. It only shrinks:`,
      growth,
    ),
    section("Config:", config),
  ].join("");
};

const baselineExists = async (): Promise<boolean> => {
  try {
    await readFile(path.join(ROOT, BASELINE_PATH), "utf8");
    return true;
  } catch {
    return false;
  }
};

/** Writes the first baseline. Refuses once one exists: it only shrinks. */
const init = async (): Promise<void> => {
  if (await baselineExists()) {
    throw new Error(`${BASELINE_PATH} exists, and it only shrinks.`);
  }
  await writeBaseline(await collect());
};

const printReport = async (): Promise<void> => {
  process.stdout.write(`${report(await readBaseline(), REPORT_LIMIT)}\n`);
};

/** A note on counts below the baseline. They pass; the workflow lowers it. */
const belowBaseline = (found: Counts, baseline: Counts): string => {
  const { stale } = compare(found, baseline);
  return stale.length === 0
    ? ""
    : ` ${String(stale.length)} file × rule counts are below the baseline; the lint-shrink workflow lowers it after merge (or run \`npm run lint:shrink\`).`;
};

const verify = async (shrinkFirst: boolean): Promise<void> => {
  const found = await collect();
  if (shrinkFirst) {
    await writeBaseline(shrink(found, await readBaseline()));
  }
  const problems = await check(found, await readBaseline());
  if (problems !== "") {
    process.stderr.write(`lint ratchet failed:\n${problems}`);
    process.exitCode = 1;
    return;
  }
  const [summary] = report(found, 0).split("\n");
  process.stdout.write(
    `lint ratchet: ${summary ?? ""}, none new.${belowBaseline(found, await readBaseline())}\n`,
  );
};

const MODES: Readonly<Record<string, () => Promise<void>>> = {
  "--init": init,
  "--report": printReport,
  "--shrink": async () => verify(true),
};

await (MODES[process.argv[2] ?? ""] ?? (async () => verify(false)))();
