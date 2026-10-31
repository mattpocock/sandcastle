// The deletion gate for moving a legacy test to tests/ (Q5 of the e2e move).
// Given one legacy test file, it measures line coverage three times:
//
//   A  the file alone
//   B  every other legacy test (the legacy vitest project minus the file)
//   C  the end-to-end tests (the e2e project)
//
// Lines in A but not in B are the ones only this file covers: deleting it
// loses them unless C covers them. The gate passes when C covers every one.
// It prints a Markdown report for the migration PR's body, and exits 1 when
// the gate fails.
//
//   npm run coverage:gate -- src/boundedTail.test.ts
//
// See .sandcastle/CODING_STANDARDS.md, "Where tests live".

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const ROOT = path.resolve(import.meta.dirname, "..");
const VITEST = path.join(ROOT, "node_modules", ".bin", "vitest");
const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_LISTED_RANGES = 40;

const Coverage = z.record(
  z.string(),
  z.object({
    statementMap: z.record(
      z.string(),
      z.object({ start: z.object({ line: z.number() }) }),
    ),
    s: z.record(z.string(), z.number()),
  }),
);

/** Repo-relative file → covered line numbers. */
type Lines = Map<string, Set<number>>;

interface Run {
  readonly label: string;
  readonly args: readonly string[];
}

/** Runs vitest; resolves whether every test passed. */
const vitest: (args: readonly string[]) => Promise<boolean> = promisify(
  (
    args: readonly string[],
    callback: (error: Error | null, passed: boolean) => void,
  ): void => {
    execFile(VITEST, args, { cwd: ROOT, maxBuffer: MAX_BUFFER }, (error) => {
      callback(null, error === null);
    });
  },
);

/** Runs vitest with coverage; resolves the covered lines, failing or not. */
const coveredLines = async ({ label, args }: Run): Promise<Lines> => {
  const dir = await mkdtemp(path.join(tmpdir(), "coverage-gate-"));
  try {
    const passed = await vitest([
      "run",
      ...args,
      "--coverage.enabled",
      "--coverage.reporter=json",
      "--coverage.reportOnFailure",
      `--coverage.reportsDirectory=${dir}`,
    ]);
    if (!passed) {
      process.stderr.write(
        `coverage-gate: ${label} had failing tests; its coverage still counts. Run \`npm run build\` first: some legacy tests need dist.\n`,
      );
    }
    const source = await readFile(
      path.join(dir, "coverage-final.json"),
      "utf8",
    );
    const lines: Lines = new Map();
    for (const [file, data] of Object.entries(
      Coverage.parse(JSON.parse(source)),
    )) {
      const hit = new Set(
        Object.entries(data.s)
          .filter(([, count]) => count > 0)
          .map(([id]) => data.statementMap[id]?.start.line ?? 0)
          .filter((line) => line > 0),
      );
      lines.set(path.relative(ROOT, file), hit);
    }
    return lines;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Lines in `a` that `b` lacks. */
const minus = (a: Lines, b: Lines): Lines =>
  new Map(
    [...a]
      .map(([file, lines]): [string, Set<number>] => [
        file,
        new Set([...lines].filter((l) => b.get(file)?.has(l) !== true)),
      ])
      .filter(([, lines]) => lines.size > 0),
  );

const total = (lines: Lines): number =>
  [...lines.values()].reduce((sum, set) => sum + set.size, 0);

/** `3, 4, 5, 9` → `3-5, 9`. */
const ranges = (lines: ReadonlySet<number>): string => {
  const sorted = [...lines].toSorted((a, b) => a - b);
  const out: string[] = [];
  let start = sorted[0] ?? 0;
  let prev = start;
  for (const line of [...sorted.slice(1), Number.NaN]) {
    if (line !== prev + 1) {
      out.push(
        start === prev ? String(start) : `${String(start)}-${String(prev)}`,
      );
      start = line;
    }
    prev = line;
  }
  return out.join(", ");
};

const table = (lines: Lines): string[] =>
  [...lines]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_LISTED_RANGES)
    .map(
      ([file, set]) => `| \`${file}\` | ${String(set.size)} | ${ranges(set)} |`,
    );

const report = (file: string, only: Lines, missing: Lines): string => {
  const verdict =
    total(missing) === 0
      ? `**Gate: pass.** The e2e tests cover all ${String(total(only))} lines that only \`${file}\` covers.`
      : `**Gate: fail.** ${String(total(missing))} of the ${String(total(only))} lines that only \`${file}\` covers have no e2e coverage yet.`;
  const missingTable =
    total(missing) === 0
      ? []
      : [
          "",
          "Not yet covered end to end:",
          "",
          "| File | Lines | Line numbers |",
          "| --- | --- | --- |",
          ...table(missing),
        ];
  return [
    `### Coverage gate: \`${file}\``,
    "",
    verdict,
    "",
    `Lines covered only by this file, out of the other legacy tests: ${String(total(only))} across ${String(only.size)} files.`,
    ...missingTable,
    "",
    "_Generated by `npm run coverage:gate`._",
  ].join("\n");
};

const main = async (): Promise<void> => {
  const file = process.argv.at(2);
  if (file === undefined) {
    throw new Error("usage: npm run coverage:gate -- <legacy test file>");
  }
  const relative = path.relative(ROOT, path.resolve(file));
  // One after another: the legacy suite has timing-sensitive tests.
  const alone = await coveredLines({
    label: "the file alone",
    args: ["--project", "legacy", relative],
  });
  const others = await coveredLines({
    label: "the other legacy tests",
    args: ["--project", "legacy", "--exclude", relative],
  });
  const e2e = await coveredLines({
    label: "the e2e tests",
    args: ["--project", "e2e"],
  });
  const only = minus(alone, others);
  const missing = minus(only, e2e);
  process.stdout.write(`${report(relative, only, missing)}\n`);
  if (total(missing) > 0) {
    process.exitCode = 1;
  }
};

await main();
