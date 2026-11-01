import { describe, expect, it } from "vitest";
import { isRawGitScanned, spawnsGitDirectly } from "./lint-ratchet-raw-git.ts";

describe("ratchet/raw-git-spawn", () => {
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
    [`execSync("git rev-parse HEAD");`],
    [`spawnSync("git", ["status"]);`],
    [`execFileSync('git', ["status"]);`],
    [`exec("git status");`],
    [`import { spawn } from "child_process";\nrun("git", ["status"]);`],
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
    [`// execFile("git", ["status"]);`],
    [`/* spawn("git", ["status"]); */`],
    [`/**\n * execSync("git status")\n */`],
    [`myexec("git status");`],
  ])(
    "does not flag sandbox-side git, other spawns or comments: %s",
    (source) => {
      expect(spawnsGitDirectly(source)).toBe(false);
    },
  );

  it.each([
    ["src/foo.ts", true],
    ["src/nested/deep/foo.ts", true],
    ["src/types.d.ts", true],
    ["src/hostGit.ts", false],
    ["src/testSandbox.ts", false],
    ["src/testSetup.ts", false],
    ["src/nested/hostGit.ts", true],
    ["src/foo.test.ts", false],
    ["src/foo.mts", false],
    ["src/foo.js", false],
    ["src/__fixtures__/foo.ts", false],
    ["src/a/__fixtures__/foo.ts", false],
    ["src/templates/foo.ts", false],
    ["src/a/templates/b/foo.ts", false],
    ["scripts/foo.ts", false],
    ["tests/foo.ts", false],
  ])("scans %s: %s", (file, scanned) => {
    expect(isRawGitScanned(file)).toBe(scanned);
  });
});
