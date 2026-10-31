import { describe, expect, it } from "vitest";
import {
  findCollidingWorktree,
  isManagedWorktreePath,
  isOrphanedWorktreePath,
} from "./WorktreeManager.js";

// On Windows, `git worktree list --porcelain` reports paths with forward
// slashes, while `node:path.join` produces backslashes. These tests pin the
// separator-robust comparison logic by mixing the two representations the way
// a real Windows host would — something Linux/macOS CI cannot otherwise
// reproduce, since both git and `join` emit forward slashes there.

const worktreesDir = String.raw`C:\repo\.sandcastle\worktrees`;
const gitWorktreePath = "C:/repo/.sandcastle/worktrees/feature-x";
const joinWorktreePath = String.raw`C:\repo\.sandcastle\worktrees\feature-x`;

describe("findCollidingWorktree", () => {
  it("matches by branch name", () => {
    const existing = [
      { path: gitWorktreePath, branch: "feature-x" },
      { path: "C:/repo/.sandcastle/worktrees/other", branch: "other" },
    ];
    const collision = findCollidingWorktree(
      existing,
      "feature-x",
      joinWorktreePath,
    );
    expect(collision?.path).toBe(gitWorktreePath);
  });

  it("falls back to a path match across separator styles (mid-rebase detached HEAD)", () => {
    // git reports a null branch mid-rebase, so the branch match misses and the
    // fallback must compare the git (forward-slash) path against the join
    // (backslash) target path.
    const existing = [{ path: gitWorktreePath, branch: null }];
    const collision = findCollidingWorktree(
      existing,
      "feature-x",
      joinWorktreePath,
    );
    expect(collision?.path).toBe(gitWorktreePath);
  });

  it("returns undefined when nothing collides", () => {
    const existing = [
      { path: "C:/repo/.sandcastle/worktrees/other", branch: "other" },
    ];
    expect(
      findCollidingWorktree(existing, "feature-x", joinWorktreePath),
    ).toBeUndefined();
  });
});

describe("isManagedWorktreePath", () => {
  it("treats a git (forward-slash) path under the join (backslash) worktrees dir as managed", () => {
    expect(isManagedWorktreePath(gitWorktreePath, worktreesDir)).toBe(true);
  });

  it("treats a path outside the worktrees dir as external", () => {
    expect(
      isManagedWorktreePath("C:/repo/some-external-worktree", worktreesDir),
    ).toBe(false);
  });
});

describe("isOrphanedWorktreePath", () => {
  it("does not flag an active worktree as orphaned across separator styles", () => {
    // Regression for the Windows data-loss bug: the entry path comes from
    // `join` (backslashes) while git's active set uses forward slashes.
    const activePaths = [gitWorktreePath, "C:/repo"];
    expect(isOrphanedWorktreePath(joinWorktreePath, activePaths)).toBe(false);
  });

  it("flags a directory absent from the active set as orphaned", () => {
    const activePaths = ["C:/repo"];
    expect(isOrphanedWorktreePath(joinWorktreePath, activePaths)).toBe(true);
  });
});
