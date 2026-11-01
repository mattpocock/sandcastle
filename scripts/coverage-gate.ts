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
// C merges every source of end-to-end coverage, and the report names each:
//
// - the e2e tests' own vitest process (this machine);
// - CLI subprocesses: any Node process an e2e test spawns (dist/main.js)
//   writes raw V8 coverage to NODE_V8_COVERAGE, mapped back to src/ through
//   dist's source maps. dist/ is rebuilt first if stale;
// - the windows CI job, given `--coverage-from <dir>`: its e2e step uploads
//   coverage-final.json as the `e2e-coverage-windows` artifact, so code that
//   runs only on win32 can count. Fetch it from the PR's CI run with
//   `gh run download <run-id> -n e2e-coverage-windows -D <dir>`.
//   The flag repeats, and takes a coverage-final.json or a folder holding one.
//
//   npm run coverage:gate -- src/boundedTail.test.ts [--coverage-from <dir>]
//
// The decisions live in scripts/coverage-gate-core.ts and
// scripts/coverage-gate-v8.ts; running vitest, in scripts/coverage-e2e.ts.
// See .sandcastle/CODING_STANDARDS.md, "Where tests live".

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  linesFromIstanbul,
  merge,
  minus,
  missing,
  report,
  total,
} from "./coverage-gate-core.ts";
import type { Lines } from "./coverage-gate-core.ts";
import { ROOT, coverage, e2eCoverage, ensureBuild } from "./coverage-e2e.ts";

const WINDOWS_ARTIFACT = "e2e-coverage-windows";

/** Coverage from another machine: a coverage-final.json, or a folder with one. */
const extraLines = async (input: string): Promise<Lines> => {
  const info = await stat(input);
  const file = info.isDirectory()
    ? path.join(input, "coverage-final.json")
    : input;
  return linesFromIstanbul(JSON.parse(await readFile(file, "utf8")), ROOT);
};

/** The legacy test file, repo-relative, and the `--coverage-from` inputs. */
const parseCli = (): { file: string; coverageFrom: readonly string[] } => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "coverage-from": { type: "string", multiple: true } },
  });
  const [file] = positionals;
  if (file === undefined || positionals.length > 1) {
    throw new Error(
      "usage: npm run coverage:gate -- <legacy test file> [--coverage-from <dir>]...",
    );
  }
  return {
    file: path.relative(ROOT, path.resolve(file)),
    coverageFrom: values["coverage-from"] ?? [],
  };
};

/** Coverage from `--coverage-from`, and a report line per input. */
const extraSources = async (
  inputs: readonly string[],
): Promise<{ lines: Lines[]; sources: string[] }> => {
  if (inputs.length === 0) {
    return {
      lines: [],
      sources: [
        `windows CI job: not counted. To count it, run \`gh run download <run-id> -n ${WINDOWS_ARTIFACT} -D <dir>\` and pass \`--coverage-from <dir>\`.`,
      ],
    };
  }
  const lines = await Promise.all(
    inputs.map(async (input) => extraLines(input)),
  );
  return {
    lines,
    sources: inputs.map(
      (input, i) =>
        `--coverage-from ${input} (e.g. the windows CI job): ${String(total(lines[i] ?? new Map()))} lines`,
    ),
  };
};

const main = async (): Promise<void> => {
  const { file, coverageFrom } = parseCli();
  // Subprocess coverage maps dist/ back to src/, so dist/ must be current.
  // Some legacy tests need it too.
  await ensureBuild();
  // One after another: the legacy suite has timing-sensitive tests.
  const alone = await coverage({
    label: "the file alone",
    args: ["--project", "legacy", file],
  });
  const others = await coverage({
    label: "the other legacy tests",
    args: ["--project", "legacy", "--exclude", file],
  });
  const local = await e2eCoverage();
  const extra = await extraSources(coverageFrom);
  const input = {
    file,
    only: minus(alone.lines, others.lines),
    e2e: merge(local.lines, ...extra.lines),
    sources: [...local.sources, ...extra.sources],
  };
  process.stdout.write(`${report(input)}\n`);
  if (total(missing(input)) > 0) {
    process.exitCode = 1;
  }
};

await main();
