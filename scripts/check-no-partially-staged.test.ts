import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("check-no-partially-staged.mjs", import.meta.url),
);

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const check = () =>
  spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "partially-staged-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "a.ts"), "one\n");
  writeFileSync(join(repo, "b.ts"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("check-no-partially-staged", () => {
  it("fails and names a staged file that also has unstaged edits", () => {
    writeFileSync(join(repo, "a.ts"), "two\n");
    git("add", "a.ts");
    writeFileSync(join(repo, "a.ts"), "three\n");

    const result = check();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a.ts");
  });

  it("passes when every staged file is staged in full", () => {
    writeFileSync(join(repo, "a.ts"), "two\n");
    writeFileSync(join(repo, "new.ts"), "new\n");
    git("add", "a.ts", "new.ts");
    git("rm", "-q", "b.ts");

    const result = check();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("ignores unstaged edits to files that are not staged", () => {
    writeFileSync(join(repo, "a.ts"), "two\n");
    git("add", "a.ts");
    writeFileSync(join(repo, "b.ts"), "two\n");

    expect(check().status).toBe(0);
  });
});
