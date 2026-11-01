// The sources of violations the ratchets count. Each resolves to a flat list
// of file × rule; scripts/lint-ratchet.ts tallies them.
//
// - lint ratchet: oxlint, Effect diagnostics, disable comments,
//   `toMatchObject({ k: undefined })` in tests
// - test ratchet: test files outside tests/, dependency-cruiser violations

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Exemption } from "./lint-ratchet-config.ts";
import {
  ALLOWED_DIRECTIVES,
  E2E_TESTS,
  EFFECT_EXEMPTIONS,
  TEST_FILES,
  TOOLING_TESTS,
} from "./lint-ratchet-config.ts";
import type { Violation } from "./lint-ratchet-core.ts";
import { matchObjectUndefinedCount } from "./lint-ratchet-core.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "node_modules", ".bin");
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Runs a command and resolves its stdout whatever its exit code: oxlint and
 * the Effect language service both exit non-zero when they find something.
 * Rejects only when the command printed nothing to stdout.
 */
export const run: (bin: string, args: readonly string[]) => Promise<string> =
  promisify(
    (
      bin: string,
      args: readonly string[],
      callback: (error: Error | null, stdout: string) => void,
    ): void => {
      execFile(
        bin,
        args,
        { cwd: ROOT, maxBuffer: MAX_BUFFER },
        (error, stdout, stderr) => {
          if (error !== null && stdout === "") {
            callback(new Error(`${bin} failed: ${stderr}`), "");
            return;
          }
          callback(null, stdout);
        },
      );
    },
  );

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
      .replaceAll("**/", "\u0000")
      .replaceAll("*", "[^/]*")
      .replaceAll("\u0000", "(?:.*/)?")}$`,
    "u",
  );

const matchesAny = (globs: readonly string[], file: string): boolean =>
  globs.some((glob) => globToRegExp(glob).test(file));

const isExempt = (
  exemptions: readonly Exemption[],
  { file, rule }: Violation,
): boolean =>
  exemptions.some((e) => e.rules.includes(rule) && matchesAny(e.files, file));

const OxlintOutput = z.object({
  diagnostics: z.array(
    z.object({
      // Absent on an unused disable directive.
      code: z.string().default("oxlint(unused-disable-directive)"),
      filename: z.string(),
    }),
  ),
});

/** oxlint, type-aware, configured by .oxlintrc.json. */
export const collectOxlint = async (): Promise<Violation[]> => {
  const out = await run(path.join(BIN, "oxlint"), ["--format", "json"]);
  const { diagnostics } = OxlintOutput.parse(JSON.parse(out));
  return diagnostics.map((d) => ({ file: d.filename, rule: d.code }));
};

const EffectOutput = z.object({
  diagnostics: z.array(z.object({ file: z.string(), name: z.string() })),
});

/** Effect's language service, configured by the tsconfig.json plugin. */
export const collectEffect = async (): Promise<Violation[]> => {
  const out = await run(path.join(BIN, "effect-language-service"), [
    "diagnostics",
    "--project",
    path.join(ROOT, "tsconfig.json"),
    "--format",
    "json",
  ]);
  const { diagnostics } = EffectOutput.parse(JSON.parse(out));
  return diagnostics
    .map((d) => ({ file: path.relative(ROOT, d.file), rule: d.name }))
    .filter((v) => !isExempt(EFFECT_EXEMPTIONS, v))
    .map((v) => ({ file: v.file, rule: `effect/${v.rule}` }));
};

const DIRECTIVES = [
  "eslint-disable",
  "eslint-enable",
  "oxlint-disable",
  "oxlint-enable",
  "@ts-ignore",
  "@ts-nocheck",
  "@ts-expect-error",
  "@effect-diagnostics",
];
const DIRECTIVE = new RegExp(
  String.raw`(?:\/\/|\/\*)\s*(?<directive>${DIRECTIVES.join("|")})`,
  "gu",
);
const SCANNED_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs"]);

const directivesIn = async (file: string): Promise<Violation[]> => {
  const source = await readFile(path.join(ROOT, file), "utf8");
  return [...source.matchAll(DIRECTIVE)]
    .map((m) => ({ file, rule: m.groups?.["directive"] ?? "" }))
    .filter((v) => !isExempt(ALLOWED_DIRECTIVES, v))
    .map(() => ({ file, rule: "ratchet/disable-comment" }));
};

/** Tracked and untracked files, minus the gitignored ones. */
const listFiles = async (): Promise<string[]> => {
  const listed = await run("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  return listed.split("\n").filter((f) => f !== "");
};

/** Inline disable comments outside ALLOWED_DIRECTIVES. */
export const collectDirectives = async (): Promise<Violation[]> => {
  const listed = await listFiles();
  const files = listed.filter((f) => SCANNED_EXTENSIONS.has(path.extname(f)));
  const perFile = await Promise.all(
    files.map(async (file) => directivesIn(file)),
  );
  return perFile.flat();
};

const matchObjectUndefinedIn = async (file: string): Promise<Violation[]> => {
  const source = await readFile(path.join(ROOT, file), "utf8");
  return Array.from({ length: matchObjectUndefinedCount(source) }, () => ({
    file,
    rule: "ratchet/match-object-undefined",
  }));
};

/**
 * `toMatchObject({ k: undefined })` in a test. It passes where `k` is set to
 * `undefined` and fails where `k` is omitted, so it is green on one platform
 * and red on another (c6c70c3).
 */
export const collectMatchObjectUndefined = async (): Promise<Violation[]> => {
  const listed = await listFiles();
  const tests = listed.filter((f) =>
    matchesAny([...TEST_FILES, ...TOOLING_TESTS], f),
  );
  const perFile = await Promise.all(
    tests.map(async (file) => matchObjectUndefinedIn(file)),
  );
  return perFile.flat();
};

const TEST_FILE = /\.test\.[cm]?tsx?$/u;

/** Each test file outside tests/ and the tooling tests, once. */
export const collectLegacyTests = async (): Promise<Violation[]> => {
  const listed = await listFiles();
  return listed
    .filter(
      (f) =>
        TEST_FILE.test(f) &&
        !matchesAny(E2E_TESTS, f) &&
        !matchesAny(TOOLING_TESTS, f),
    )
    .map((file) => ({ file, rule: "ratchet/test-outside-tests" }));
};

const DepcruiseOutput = z.object({
  summary: z.object({
    violations: z.array(
      z.object({ from: z.string(), rule: z.object({ name: z.string() }) }),
    ),
  }),
});

/** dependency-cruiser, configured by .dependency-cruiser.mjs. */
export const collectDepcruise = async (): Promise<Violation[]> => {
  const out = await run(path.join(BIN, "depcruise"), [
    "src",
    "tests",
    "--output-type",
    "json",
  ]);
  const { summary } = DepcruiseOutput.parse(JSON.parse(out));
  return summary.violations.map((v) => ({
    file: v.from,
    rule: `depcruise/${v.rule.name}`,
  }));
};
