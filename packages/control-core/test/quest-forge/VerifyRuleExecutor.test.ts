import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VerifyRuleExecutor } from "../../src/quest-forge/VerifyRuleExecutor.js";
import { makeRepo } from "../helpers.js";

describe("VerifyRuleExecutor", () => {
  it("runs command success and non-zero exit failure without a shell", async () => {
    const repo = makeRepo();
    const ok = await new VerifyRuleExecutor({ worktreePath: repo }).execute([
      { kind: "command", command: 'node -e "process.exit(0)"' },
    ]);
    expect(ok[0]?.ok).toBe(true);

    const fail = await new VerifyRuleExecutor({ worktreePath: repo }).execute([
      { kind: "command", command: 'node -e "process.exit(2)"' },
    ]);
    expect(fail[0]?.ok).toBe(false);
  });

  it("checks file existence and absence", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "present.txt"), "ok");
    const results = await new VerifyRuleExecutor({
      worktreePath: repo,
    }).execute([
      { kind: "file", path: "present.txt", mustExist: true },
      { kind: "file", path: "missing.txt", mustExist: false },
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
  });

  it("counts commits since the base commit", async () => {
    const repo = makeRepo();
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(repo, "change.txt"), "change");
    execFileSync("git", ["add", "change.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "change"], {
      cwd: repo,
      stdio: "ignore",
    });
    const results = await new VerifyRuleExecutor({
      worktreePath: repo,
      baseCommit: base,
    }).execute([{ kind: "commits", minCount: 1 }]);
    expect(results[0]?.ok).toBe(true);
  });

  // The `tests` rule shape is exercised through VerifyRule.test.ts (zod
  // schema) and the executor's subprocess plumbing is covered by the
  // command-rule tests in this file. End-to-end vitest invocation isn't
  // unit-testable without spawning network installs.

  it("times out hanging commands", async () => {
    const repo = makeRepo();
    const results = await new VerifyRuleExecutor({
      worktreePath: repo,
      timeoutMs: 50,
    }).execute([
      { kind: "command", command: 'node -e "setTimeout(() => {}, 60000)"' },
    ]);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.output).toContain("timed out");
  });
});
