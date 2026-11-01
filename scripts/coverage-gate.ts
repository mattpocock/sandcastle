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
// scripts/coverage-gate-v8.ts.
// See .sandcastle/CODING_STANDARDS.md, "Where tests live".

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  linesFromIstanbul,
  merge,
  minus,
  missing,
  report,
  total,
} from "./coverage-gate-core.ts";
import type { Lines } from "./coverage-gate-core.ts";
import { linesFromV8 } from "./coverage-gate-v8.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "node_modules", ".bin");
const MAX_BUFFER = 256 * 1024 * 1024;
const WINDOWS_ARTIFACT = "e2e-coverage-windows";

interface Run {
  readonly label: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

interface Command {
  /** A binary in node_modules/.bin. */
  readonly bin: string;
  readonly args: readonly string[];
  /** Added to this process's environment. */
  readonly env: NodeJS.ProcessEnv;
}

/** Runs a command; resolves whether it exited 0. */
const run: (command: Command) => Promise<boolean> = promisify(
  (
    { bin, args, env }: Command,
    callback: (error: Error | null, passed: boolean) => void,
  ): void => {
    execFile(
      path.join(BIN, bin),
      args,
      { cwd: ROOT, maxBuffer: MAX_BUFFER, env: { ...process.env, ...env } },
      (error) => {
        callback(null, error === null);
      },
    );
  },
);

/** Runs vitest with coverage; resolves the covered lines, failing or not. */
const coveredLines = async ({ label, args, env = {} }: Run): Promise<Lines> => {
  const dir = await mkdtemp(path.join(tmpdir(), "coverage-gate-"));
  try {
    const passed = await run({
      bin: "vitest",
      args: [
        "run",
        ...args,
        "--coverage.enabled",
        "--coverage.reporter=json",
        "--coverage.reportOnFailure",
        `--coverage.reportsDirectory=${dir}`,
      ],
      env,
    });
    if (!passed) {
      process.stderr.write(
        `coverage-gate: ${label} had failing tests; its coverage still counts.\n`,
      );
    }
    const source = await readFile(
      path.join(dir, "coverage-final.json"),
      "utf8",
    );
    return linesFromIstanbul(JSON.parse(source), ROOT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Every built script and source map in dist/, by absolute path. */
const readDist = async (): Promise<Map<string, string>> => {
  const dist = path.join(ROOT, "dist");
  const entries = await readdir(dist, { recursive: true });
  const names = entries.filter(
    (name) => name.endsWith(".js") || name.endsWith(".js.map"),
  );
  return new Map(
    await Promise.all(
      names.map(
        async (name): Promise<[string, string]> => [
          path.join(dist, name),
          await readFile(path.join(dist, name), "utf8"),
        ],
      ),
    ),
  );
};

/** Covered src/ lines per process that wrote a report into `dir`. */
const subprocessLines = async (dir: string): Promise<Lines[]> => {
  const dist = await readDist();
  const reports = await readdir(dir);
  const perProcess = await Promise.all(
    reports.map(async (name) => {
      const json: unknown = JSON.parse(
        await readFile(path.join(dir, name), "utf8"),
      );
      return linesFromV8(json, ROOT, (file) => dist.get(file));
    }),
  );
  return perProcess.filter((lines) => lines.size > 0);
};

/** The e2e run, plus the CLI subprocesses its tests spawned. */
const e2eLines = async (): Promise<{ lines: Lines; sources: string[] }> => {
  const v8 = await mkdtemp(path.join(tmpdir(), "coverage-gate-v8-"));
  try {
    const inProcess = await coveredLines({
      label: "the e2e tests",
      args: ["--project", "e2e"],
      env: { NODE_V8_COVERAGE: v8 },
    });
    const processes = await subprocessLines(v8);
    const subprocess = merge(...processes);
    return {
      lines: merge(inProcess, subprocess),
      sources: [
        `e2e tests in vitest (this machine): ${String(total(inProcess))} lines`,
        `CLI subprocesses spawned by e2e tests (built dist/, source-mapped to src/): ${String(processes.length)} processes, ${String(total(subprocess))} lines`,
      ],
    };
  } finally {
    await rm(v8, { recursive: true, force: true });
  }
};

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
  if (
    !(await run({ bin: "tsx", args: ["scripts/ensure-build.ts"], env: {} }))
  ) {
    throw new Error("coverage-gate: `npm run build` failed");
  }
  // One after another: the legacy suite has timing-sensitive tests.
  const alone = await coveredLines({
    label: "the file alone",
    args: ["--project", "legacy", file],
  });
  const others = await coveredLines({
    label: "the other legacy tests",
    args: ["--project", "legacy", "--exclude", file],
  });
  const local = await e2eLines();
  const extra = await extraSources(coverageFrom);
  const input = {
    file,
    only: minus(alone, others),
    e2e: merge(local.lines, ...extra.lines),
    sources: [...local.sources, ...extra.sources],
  };
  process.stdout.write(`${report(input)}\n`);
  if (total(missing(input)) > 0) {
    process.exitCode = 1;
  }
};

await main();
