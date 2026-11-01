import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";

const ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "\\": "\\",
};

/** Strips matching quotes; double-quoted values also expand \n, \r, \t, \\. */
const unquote = (value: string): string => {
  const isDoubleQuoted =
    value.length >= 2 && value.startsWith('"') && value.at(-1) === '"';
  const isSingleQuoted =
    value.length >= 2 && value.startsWith("'") && value.at(-1) === "'";
  if (isSingleQuoted) {
    return value.slice(1, -1);
  }
  if (!isDoubleQuoted) {
    return value;
  }
  return value
    .slice(1, -1)
    .replaceAll(/\\(?<escape>[nrt\\])/gu, (_, ch: string) => ESCAPES[ch] ?? ch);
};

/** One `KEY=value` line as a pair, or undefined for blanks and comments. */
const parseEnvLine = (line: string): [string, string] | undefined => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) {
    return undefined;
  }
  const key = trimmed.slice(0, eqIndex).trim();
  return [key, unquote(trimmed.slice(eqIndex + 1).trim())];
};

const parseEnvFile = (
  filePath: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) {
      return {};
    }
    const entries = content
      .split("\n")
      .map((line) => parseEnvLine(line))
      .filter((entry) => entry !== undefined);
    return Object.fromEntries(entries);
  });

/**
 * Resolve all env vars from .env files with process.env fallback.
 *
 * Precedence: `<stateDir>/.env` > process.env
 * Only keys declared in `<stateDir>/.env` are resolved from process.env.
 * Repo root .env is not part of the resolution chain.
 *
 * `stateDir` is the already-resolved absolute state directory (see
 * `resolveStateDir`) — callers resolve it once at the entry point.
 */
export const resolveEnv = (
  stateDir: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const sandcastleEnv = yield* parseEnvFile(join(stateDir, ".env"));

    const result: Record<string, string> = {};
    for (const [key, fileValue] of Object.entries(sandcastleEnv)) {
      const value = fileValue || (process.env[key] ?? "");
      if (value) {
        result[key] = value;
      }
    }

    return result;
  });
