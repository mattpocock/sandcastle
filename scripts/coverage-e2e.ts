// Running vitest with coverage, shared by scripts/coverage-gate.ts (the
// deletion gate) and scripts/coverage-floor.ts (the e2e coverage floor).
//
// End-to-end coverage merges the e2e tests' own vitest process with the CLI
// subprocesses they spawn: any Node process running the built dist/ writes
// raw V8 coverage to NODE_V8_COVERAGE, mapped back to src/ through dist's
// source maps (scripts/coverage-gate-v8.ts). dist/ must be current.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  coverableLinesFromIstanbul,
  linesFromIstanbul,
  merge,
  total,
} from "./coverage-gate-core.ts";
import type { Lines } from "./coverage-gate-core.ts";
import { linesFromV8 } from "./coverage-gate-v8.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "node_modules", ".bin");
const MAX_BUFFER = 256 * 1024 * 1024;

export interface Run {
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

/**
 * Runs a command; resolves whether it exited 0. A failing command's output
 * goes to stderr, so a failing test shows; stdout stays for the report.
 */
export const run: (command: Command) => Promise<boolean> = promisify(
  (
    { bin, args, env }: Command,
    callback: (error: Error | null, passed: boolean) => void,
  ): void => {
    execFile(
      path.join(BIN, bin),
      args,
      { cwd: ROOT, maxBuffer: MAX_BUFFER, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error !== null) {
          process.stderr.write(`${stdout}${stderr}`);
        }
        callback(null, error === null);
      },
    );
  },
);

/** What one vitest run with coverage found. */
export interface Coverage {
  /** Lines the run covered. */
  readonly lines: Lines;
  /** Every line with a statement in src/, covered or not. */
  readonly coverable: Lines;
  /** Whether every test passed. Coverage counts either way. */
  readonly passed: boolean;
}

/** Runs vitest with coverage; resolves its coverage, failing or not. */
export const coverage = async ({
  label,
  args,
  env = {},
}: Run): Promise<Coverage> => {
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
        `coverage: ${label} had failing tests; its coverage still counts.\n`,
      );
    }
    const json: unknown = JSON.parse(
      await readFile(path.join(dir, "coverage-final.json"), "utf8"),
    );
    return {
      lines: linesFromIstanbul(json, ROOT),
      coverable: coverableLinesFromIstanbul(json, ROOT),
      passed,
    };
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

/** The e2e run plus the CLI subprocesses it spawned, and a line per source. */
export interface E2eCoverage extends Coverage {
  readonly sources: readonly string[];
}

/** The e2e run, plus the CLI subprocesses its tests spawned. */
export const e2eCoverage = async (): Promise<E2eCoverage> => {
  const v8 = await mkdtemp(path.join(tmpdir(), "coverage-gate-v8-"));
  try {
    const inProcess = await coverage({
      label: "the e2e tests",
      args: ["--project", "e2e"],
      env: { NODE_V8_COVERAGE: v8 },
    });
    const processes = await subprocessLines(v8);
    const subprocess = merge(...processes);
    return {
      ...inProcess,
      lines: merge(inProcess.lines, subprocess),
      sources: [
        `e2e tests in vitest (this machine): ${String(total(inProcess.lines))} lines`,
        `CLI subprocesses spawned by e2e tests (built dist/ or src/ through tsx, source-mapped to src/): ${String(processes.length)} processes, ${String(total(subprocess))} lines`,
      ],
    };
  } finally {
    await rm(v8, { recursive: true, force: true });
  }
};

/** Rebuilds dist/ if stale: subprocess coverage maps it back to src/. */
export const ensureBuild = async (): Promise<void> => {
  if (
    !(await run({ bin: "tsx", args: ["scripts/ensure-build.ts"], env: {} }))
  ) {
    throw new Error("coverage: `npm run build` failed");
  }
};
