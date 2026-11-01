#!/usr/bin/env node
/**
 * Fail the build if any bundled .d.ts file under `dist/` references
 * `effect` or `@effect/*` packages.
 *
 * Effect powers Sandcastle's internals but must never leak into the public
 * type surface. See CODING_STANDARDS.md.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const distDir = join(here, "..", "dist");

/** Matches a string-literal module specifier of `effect` or `@effect/<sub>`. */
const EFFECT_IMPORT_PATTERN = /(["'])(?:effect(?:\/[^"']+)?|@effect\/[^"']+)\1/;

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      yield path;
    }
  }
}

const offenders = [];
let scanned = 0;
for await (const file of walk(distDir)) {
  scanned++;
  const contents = await readFile(file, "utf8");
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (EFFECT_IMPORT_PATTERN.test(line)) {
      offenders.push({
        file: relative(distDir, file),
        line: i + 1,
        snippet: line.trim(),
      });
    }
  }
}

if (scanned === 0) {
  console.error(
    `✗ No .d.ts files found under ${distDir}. Did the build emit declarations?`,
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(
    "✗ Effect leaked into public .d.ts files (Effect must never appear in the published type surface):",
  );
  for (const { file, line, snippet } of offenders) {
    console.error(`  dist/${file}:${line}  ${snippet}`);
  }
  console.error(
    "\nFix: refactor so the offending types don't reach a public entry point,\n" +
      "or wrap the affected class/type with a public shape that doesn't reference Effect.\n" +
      "See src/CwdError.ts for an example.",
  );
  process.exit(1);
}

console.log("✓ No Effect references in public .d.ts files");
