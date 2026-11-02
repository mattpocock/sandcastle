// The package entry points are listed three times: package.json `exports` (what
// users import), tsup.config.ts `entry` (what gets built) and the
// ENTRY_POINTS in .dependency-cruiser.mjs (what tests/ may import). Adding a
// sandbox provider means touching all three, and a missed list fails nowhere
// else. scripts/entry-points.test.ts runs this check over the real files.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface EntryPointLists {
  /** package.json `exports`: subpath -> conditions. */
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** package.json `bin`: command -> built file. */
  readonly bin: Readonly<Record<string, string>>;
  /** tsup.config.ts `entry`: output name -> source file. */
  readonly tsupEntries: Readonly<Record<string, string>>;
  /** The ENTRY_POINTS pattern in .dependency-cruiser.mjs. */
  readonly cruiserEntryPoints: string;
  /** Every `.ts` file under src/, relative to the repo root, `/`-separated. */
  readonly srcFiles: readonly string[];
}

/** `"."` -> `"index"`, `"./sandboxes/docker"` -> `"sandboxes/docker"`. */
const outputName = (subpath: string): string =>
  subpath === "." ? "index" : subpath.slice(2);

const checkExport = (
  lists: EntryPointLists,
  cruiser: RegExp,
  [subpath, conditions]: readonly [string, Readonly<Record<string, string>>],
): string[] => {
  const name = outputName(subpath);
  const source = `src/${name}.ts`;
  const problems: string[] = [];
  const expected = {
    import: `./dist/${name}.js`,
    types: `./dist/${name}.d.ts`,
  };
  for (const [condition, file] of Object.entries(expected)) {
    if (conditions[condition] !== file) {
      problems.push(
        `package.json exports "${subpath}" ${condition} is ${conditions[condition] ?? "missing"}, expected ${file}`,
      );
    }
  }
  const entry = lists.tsupEntries[name];
  if (entry === undefined) {
    problems.push(
      `package.json exports "${subpath}" has no tsup.config.ts entry "${name}"`,
    );
  } else if (entry !== source) {
    problems.push(
      `tsup.config.ts entry "${name}" is ${entry}, expected ${source}`,
    );
  }
  if (!cruiser.test(source)) {
    problems.push(
      `package.json exports "${subpath}" (${source}) is not in the .dependency-cruiser.mjs ENTRY_POINTS`,
    );
  }
  return problems;
};

/** Every way the three lists disagree, one line each. Empty when they agree. */
export const checkEntryPoints = (lists: EntryPointLists): string[] => {
  const cruiser = new RegExp(lists.cruiserEntryPoints, "u");
  const exported = new Set(
    Object.keys(lists.exports).map((subpath) => outputName(subpath)),
  );
  const binNames = new Set(
    Object.values(lists.bin).map((file) =>
      file.replace(/^(?:\.\/)?dist\//u, "").replace(/\.js$/u, ""),
    ),
  );

  const problems = Object.entries(lists.exports).flatMap((entry) =>
    checkExport(lists, cruiser, entry),
  );
  for (const name of Object.keys(lists.tsupEntries)) {
    if (!exported.has(name) && !binNames.has(name)) {
      problems.push(
        `tsup.config.ts entry "${name}" is neither a package.json export nor a bin`,
      );
    }
  }
  for (const file of lists.srcFiles) {
    if (cruiser.test(file) && !exported.has(file.slice(4, -3))) {
      problems.push(
        `.dependency-cruiser.mjs ENTRY_POINTS matches ${file}, which no package.json export points at`,
      );
    }
  }
  return problems;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringRecord = (value: unknown, what: string): Record<string, string> => {
  if (!isRecord(value)) {
    throw new Error(`${what} is not an object`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new TypeError(`${what}.${key} is not a string`);
    }
    result[key] = item;
  }
  return result;
};

const root = fileURLToPath(new URL("..", import.meta.url));

/** Reads the three lists from this repo. */
export const readEntryPointLists = async (): Promise<EntryPointLists> => {
  const pkg: unknown = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (!isRecord(pkg) || !isRecord(pkg.exports)) {
    throw new Error("package.json has no exports object");
  }
  const exports: Record<string, Record<string, string>> = {};
  for (const [subpath, conditions] of Object.entries(pkg.exports)) {
    exports[subpath] = stringRecord(conditions, `exports["${subpath}"]`);
  }

  const tsupModule = await import("../tsup.config.ts");
  const tsup: unknown = tsupModule.default;
  if (!isRecord(tsup)) {
    throw new Error("tsup.config.ts is not one object");
  }

  const cruiserModule: unknown = await import(
    // A URL, not a specifier: the .mjs has no types to check against.
    new URL("../.dependency-cruiser.mjs", import.meta.url).href
  );
  const cruiser = isRecord(cruiserModule)
    ? cruiserModule.ENTRY_POINTS
    : undefined;
  if (typeof cruiser !== "string") {
    throw new TypeError(".dependency-cruiser.mjs exports no ENTRY_POINTS");
  }

  const allFiles = await readdir(path.join(root, "src"), { recursive: true });
  const srcFiles = allFiles
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `src/${file.split(path.sep).join("/")}`);

  return {
    exports,
    bin: stringRecord(pkg.bin ?? {}, "bin"),
    tsupEntries: stringRecord(tsup.entry, "tsup entry"),
    cruiserEntryPoints: cruiser,
    srcFiles,
  };
};
