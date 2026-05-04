import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/telemetry/SqliteStore.js";
import { TelemetryIndexer } from "../../src/telemetry/TelemetryIndexer.js";

const makeGitRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-telemetry-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  mkdirSync(join(dir, ".sandcastle"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# test\n");
  writeFileSync(join(dir, "unit.test.ts"), "test('x', () => {});\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "thing.spec.js"), "it('x', () => {});\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
};

describe("TelemetryIndexer", () => {
  it("indexes git age, branch, last commit, and test count", async () => {
    const repo = makeGitRepo();
    const store = new SqliteStore(repo);
    try {
      const telemetry = await new TelemetryIndexer(store).getTelemetry({
        id: "repo-1",
        root: repo,
      });

      expect(telemetry.ageDays).toBeGreaterThanOrEqual(0);
      expect(telemetry.branch).toBe("main");
      expect(telemetry.lastCommitAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(telemetry.testCount).toBe(2);
      expect(store.getRepoTelemetry("repo-1")).toEqual(telemetry);
    } finally {
      store.close();
    }
  });
});
