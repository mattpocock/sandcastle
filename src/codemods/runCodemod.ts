import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import type * as TS from "typescript";
import { transformRunMany } from "./runMany.js";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/**
 * Load the caller's `typescript`. The package doesn't ship it (it's an
 * optional peer dependency), so resolve from the current project first,
 * then from wherever Sandcastle itself was installed (e.g. an `npx -p`
 * temp dir).
 */
export const loadTypeScript = async (cwd: string): Promise<typeof TS> => {
  try {
    const req = createRequire(join(cwd, "package.json"));
    return req("typescript") as typeof TS;
  } catch {
    try {
      const mod = (await import("typescript")) as unknown as {
        default?: typeof TS;
      } & typeof TS;
      return mod.default ?? mod;
    } catch {
      throw new Error(
        "The run-many codemod needs the `typescript` package. Install it in your project " +
          "(npm i -D typescript) or run: npx -p typescript -p @ai-hero/sandcastle sandcastle codemod run-many <paths…>",
      );
    }
  }
};

/** Expand file, directory and glob arguments into source files. */
export const collectFiles = (
  paths: readonly string[],
  cwd: string,
): string[] => {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
        out.add(join(dir, entry.name));
      }
    }
  };
  for (const p of paths) {
    if (/[*?{[]/.test(p)) {
      const globSync = (
        fs as {
          globSync?: (pattern: string, opts: { cwd: string }) => string[];
        }
      ).globSync;
      if (!globSync) {
        throw new Error(
          `Glob "${p}" needs Node 22+. Let your shell expand it, or pass a directory.`,
        );
      }
      for (const match of globSync(p, { cwd })) {
        const abs = resolve(cwd, match);
        if (
          SOURCE_EXTENSIONS.has(extname(abs)) &&
          !abs.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg))
        )
          out.add(abs);
      }
      continue;
    }
    const abs = resolve(cwd, p);
    if (statSync(abs).isDirectory()) walk(abs);
    else out.add(abs);
  }
  return [...out].sort();
};

export interface CodemodFileReport {
  readonly file: string;
  readonly changed: boolean;
  readonly todos: readonly string[];
}

/** Run the run→runMany codemod over `paths`. Writes files unless `dryRun`. */
export const runRunManyCodemod = async (options: {
  readonly paths: readonly string[];
  readonly cwd: string;
  readonly dryRun?: boolean;
  readonly ts?: typeof TS;
}): Promise<CodemodFileReport[]> => {
  const ts = options.ts ?? (await loadTypeScript(options.cwd));
  const reports: CodemodFileReport[] = [];
  for (const file of collectFiles(options.paths, options.cwd)) {
    const source = readFileSync(file, "utf8");
    const result = transformRunMany(ts, source, file);
    if (result.changed && !options.dryRun) writeFileSync(file, result.output);
    if (result.changed || result.todos.length > 0) {
      reports.push({ file, changed: result.changed, todos: result.todos });
    }
  }
  return reports;
};
