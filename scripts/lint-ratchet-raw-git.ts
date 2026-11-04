// The pure half of `ratchet/raw-git-spawn`: which files it scans and whether
// one starts git directly. scripts/lint-ratchet-sources.ts reads the files.
//
// Every host-side git call must go through `hostGit()` (src/hostGit.ts). A
// raw `git` spawn anywhere else in src/ bypasses it, so each file that has one
// counts once.

/** Files allowed to spawn git: the helper itself, and test-only helpers. */
const ALLOWED = new Set([
  "src/hostGit.ts",
  "src/testSandbox.ts",
  "src/testSetup.ts",
]);

/** Directories under src/, at any depth, that are not scanned. */
const SKIPPED_DIRS = new Set(["__fixtures__", "templates"]);

/** Whether `file`, relative to the repo root, is checked for raw git spawns. */
export const isRawGitScanned = (file: string): boolean => {
  const parts = file.split("/");
  return (
    parts[0] === "src" &&
    file.endsWith(".ts") &&
    !file.endsWith(".test.ts") &&
    !ALLOWED.has(file) &&
    !parts.slice(1, -1).some((dir) => SKIPPED_DIRS.has(dir))
  );
};

const stripComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");

const IMPORTS_CHILD_PROCESS =
  /(?:from\s+|import\s*\(\s*)["'](?:node:)?child_process["']/u;

/** `"git"` passed as an argument, or a string that starts a git command line. */
const GIT_COMMAND_LITERAL = /\(\s*["'`]git["'`]|["'`]git\s/u;

/**
 * A git command line passed straight to an unqualified process spawner.
 * Member calls such as `sandbox.exec("git …")` run inside the sandbox and are
 * fine.
 */
const SPAWNS_GIT =
  /(?<![.\w])(?:execHostShell|execSync|execAsync|exec|spawn|spawnSync|execFile|execFileSync)\s*\(\s*["'`]git[\s"'`]/u;

/** Whether `source` spawns git on the host without going through hostGit. */
export const spawnsGitDirectly = (source: string): boolean => {
  const code = stripComments(source);
  return (
    SPAWNS_GIT.test(code) ||
    (IMPORTS_CHILD_PROCESS.test(code) && GIT_COMMAND_LITERAL.test(code))
  );
};
