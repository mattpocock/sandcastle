import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree } from "@ai-hero/sandcastle";

// How createWorktree() treats the worktrees git already knows about: reuse
// Sandcastle's own, refuse a branch checked out elsewhere, and prune stray
// directories without touching live worktrees. git reports worktree paths with
// forward slashes even on Windows, where node:path joins with backslashes; the
// windows CI job runs these tests, so there they also pin that both spellings
// of a path are treated as the same path.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("createWorktree() and existing worktrees", () => {
  let repo = "";
  let worktreesDir = "";

  beforeEach(() => {
    repo = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "e2e-worktree-")),
    );
    worktreesDir = path.join(repo, ".sandcastle", "worktrees");
    git(repo, "init", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# repo\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "init");
  }, 30_000);

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reuses the worktree it made for a branch", async () => {
    const first = await createWorktree({
      branchStrategy: { type: "branch", branch: "feature-x" },
      cwd: repo,
    });

    const second = await createWorktree({
      branchStrategy: { type: "branch", branch: "feature-x" },
      cwd: repo,
    });

    expect(second.worktreePath).toBe(first.worktreePath);
    expect(path.dirname(second.worktreePath)).toBe(worktreesDir);
  }, 30_000);

  it("reuses its worktree when it has a detached HEAD (mid-rebase)", async () => {
    const first = await createWorktree({
      branchStrategy: { type: "branch", branch: "feature-x" },
      cwd: repo,
    });
    git(first.worktreePath, "checkout", "--detach");

    const second = await createWorktree({
      branchStrategy: { type: "branch", branch: "feature-x" },
      cwd: repo,
    });

    expect(second.worktreePath).toBe(first.worktreePath);
  }, 30_000);

  it("refuses a branch checked out outside .sandcastle/worktrees/", async () => {
    await expect(
      createWorktree({
        branchStrategy: { type: "branch", branch: "main" },
        cwd: repo,
      }),
    ).rejects.toThrow("Branch 'main' is already checked out in worktree at");
  }, 30_000);

  it("keeps a live worktree when it prunes stray directories", async () => {
    const live = await createWorktree({
      branchStrategy: { type: "branch", branch: "feature-x" },
      cwd: repo,
    });
    const stray = path.join(worktreesDir, "left-behind");
    mkdirSync(stray);

    await createWorktree({
      branchStrategy: { type: "branch", branch: "feature-y" },
      cwd: repo,
    });

    expect(existsSync(stray)).toBe(false);
    expect(existsSync(path.join(live.worktreePath, "README.md"))).toBe(true);
  }, 30_000);
});
