// Runs `npm run build` when dist/ is missing or older than its inputs, and
// does nothing otherwise. Wired in as `pretest` and `prelint`: the CLI tests
// spawn dist/main.js, and lint's type-aware rules read the package's types
// (the scripts in .sandcastle/ import @ai-hero/sandcastle, typed from dist).
// A fresh checkout, or a stale dist/ after a branch switch, gets built once;
// repeat runs skip straight to the command.
//
// Not wired into vitest itself: the windows CI job runs `npx vitest` directly
// and needs no build (postbuild uses rm/cp, which Windows lacks).

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** What the build reads: a change to any of these makes dist/ stale. */
const INPUTS = [
  "src",
  "package.json",
  "package-lock.json",
  "tsup.config.ts",
  "tsconfig.json",
  "scripts/check-public-types-effect-free.mjs",
];

/** What the build writes that the tests and lint need. */
const OUTPUTS = ["dist/main.js", "dist/index.js", "dist/index.d.ts"];

/** Newest mtime under `p` (a file or a directory), or 0 if absent. */
const newestMtime = async (p: string): Promise<number> => {
  const s = await stat(p).catch(() => undefined);
  if (s === undefined) {
    return 0;
  }
  if (!s.isDirectory()) {
    return s.mtimeMs;
  }
  const entries = await readdir(p);
  const children = await Promise.all(
    entries.map(async (entry) => newestMtime(path.join(p, entry))),
  );
  return Math.max(s.mtimeMs, ...children);
};

/** Oldest mtime among `files`, or 0 if any is missing. */
const oldestMtime = async (files: readonly string[]): Promise<number> => {
  const stats = await Promise.all(
    files.map(async (file) => stat(file).catch(() => undefined)),
  );
  if (stats.some((s) => s === undefined)) {
    return 0;
  }
  return Math.min(...stats.map((s) => s?.mtimeMs ?? 0));
};

const build = async (): Promise<void> => {
  const child = spawn("npm", ["run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  await once(child, "close");
  if (child.exitCode !== 0) {
    throw new Error(`npm run build exited with ${String(child.exitCode)}`);
  }
};

const [inputs, outputs] = await Promise.all([
  Promise.all(INPUTS.map(async (p) => newestMtime(path.join(ROOT, p)))).then(
    (ms) => Math.max(...ms),
  ),
  oldestMtime(OUTPUTS.map((p) => path.join(ROOT, p))),
]);

if (outputs === 0) {
  console.log("dist/ is missing: building first.");
  await build();
} else if (outputs < inputs) {
  console.log("dist/ is older than its sources: rebuilding first.");
  await build();
}
