import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every host-side git call must go through `hostGit()` (src/hostGit.ts),
 * which validates the repo's `.git` and neutralises config that runs
 * programs. A raw `git` spawn anywhere else in `src/` would bypass that, so
 * this guard fails on one.
 */

const SRC = join(import.meta.dirname);

/** Files allowed to spawn git: the helper itself, and test-only helpers. */
const ALLOWED = new Set(["hostGit.ts", "testSandbox.ts", "testSetup.ts"]);

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
const spawnsGitDirectly = (source: string): boolean => {
  const code = stripComments(source);
  return (
    SPAWNS_GIT.test(code) ||
    (IMPORTS_CHILD_PROCESS.test(code) && GIT_COMMAND_LITERAL.test(code))
  );
};

const listSourceFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        return e.name === "__fixtures__" || e.name === "templates"
          ? []
          : listSourceFiles(path);
      }
      return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
        ? [path]
        : [];
    }),
  );
  return nested.flat();
};

/** Source files, relative to `src/`, that spawn git without hostGit. */
const findOffenders = async (): Promise<string[]> => {
  const files = await listSourceFiles(SRC);
  const sources = await Promise.all(
    files.map(async (file) => ({
      rel: relative(SRC, file),
      source: await readFile(file, "utf8"),
    })),
  );
  return sources
    .filter(({ rel, source }) => !ALLOWED.has(rel) && spawnsGitDirectly(source))
    .map(({ rel }) => rel);
};

describe("hostGit guard", () => {
  it("no module but hostGit.ts spawns git on the host", async () => {
    await expect(findOffenders()).resolves.toStrictEqual([]);
  });

  it.each([
    [
      `import { execFile } from "node:child_process";\nexecFile("git", ["status"]);`,
    ],
    [
      `const { exec } = await import("node:child_process");\nconst c = \`git merge \${b}\`;`,
    ],
    [`await execAsync(\`git merge "\${branch}"\`, { cwd });`],
    [`execHostShell("git status", { cwd, signals: [] });`],
    [`spawn('git', ['worktree', 'add']);`],
  ])("flags a raw host git spawn: %s", (source) => {
    expect(spawnsGitDirectly(source)).toBe(true);
  });

  it.each([
    [`yield* execOk(sandbox, "git checkout --detach");`],
    [`await handle.exec("git rev-parse HEAD", { cwd });`],
    [
      `import { execFile } from "node:child_process";\nexecFile("docker", ["ps"]);`,
    ],
    [`yield* hostGit(["merge", branch], hostRepoDir);`],
  ])("does not flag sandbox-side git or other spawns: %s", (source) => {
    expect(spawnsGitDirectly(source)).toBe(false);
  });
});
