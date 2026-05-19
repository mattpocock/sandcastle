/**
 * Unit tests for the slash-normalization that lets WorktreeManager compare
 * paths from two sources with different conventions:
 *
 *   - `git worktree list --porcelain` emits forward-slash paths on every
 *     platform (e.g. "C:/dev/repo/.sandcastle/worktrees/foo").
 *   - `path.join` on Windows emits backslash paths
 *     (e.g. "C:\\dev\\repo\\.sandcastle\\worktrees\\foo").
 *
 * Without `toPosix`, the `===`, `.startsWith()`, and Set lookups inside
 * `create` (collision detection / managed-worktree reuse) and `pruneStale`
 * (active-worktree set) mismatch on Windows. Effects:
 *
 *   - `pruneStale` wipes active worktrees out from under running sandboxes,
 *     because they appear orphaned to the Set lookup.
 *   - `create` cannot reuse a managed worktree (clean or dirty / mid-rebase),
 *     because the prefix check fails and it falls through to the
 *     external-collision error path.
 *
 * These tests run identically on Windows and POSIX hosts — they exercise the
 * comparison logic with literal mixed-slash inputs rather than relying on the
 * host's `path` implementation. The end-to-end integration tests in
 * `WorktreeManager.test.ts` only exhibit the bug on Windows (where
 * `path.join` actually produces backslashes), so this file is what gives
 * Linux CI sensitivity to the fix.
 */
import { describe, expect, it } from "vitest";
import { toPosix } from "./WorktreeManager.js";

describe("toPosix", () => {
  it("converts Windows-style backslashes to forward slashes", () => {
    expect(toPosix("C:\\dev\\repo")).toBe("C:/dev/repo");
  });

  it("leaves POSIX paths unchanged", () => {
    expect(toPosix("/home/user/repo")).toBe("/home/user/repo");
  });

  it("normalizes mixed-separator paths", () => {
    expect(toPosix("C:\\dev/repo\\.sandcastle/worktrees")).toBe(
      "C:/dev/repo/.sandcastle/worktrees",
    );
  });

  it("is a no-op for the empty string", () => {
    expect(toPosix("")).toBe("");
  });
});

describe("cross-source path comparison without toPosix (documents the bug)", () => {
  // Inputs reproduce what each source emits on Windows for the same logical
  // path. These literals are platform-independent — the bug is in the
  // comparison itself, not in how the host resolves paths.
  const fromGit = "C:/dev/repo/.sandcastle/worktrees/active";
  const fromPathJoin = "C:\\dev\\repo\\.sandcastle\\worktrees\\active";
  const worktreesDirPathJoin = "C:\\dev\\repo\\.sandcastle\\worktrees";

  it("`startsWith` of git output against `path.join` prefix fails — managed-worktree reuse breaks", () => {
    expect(fromGit.startsWith(worktreesDirPathJoin)).toBe(false);
  });

  it("`Set.has` of `path.join` entry against a Set built from git output fails — active worktrees look orphaned", () => {
    const activeWorktreePaths = new Set([fromGit]);
    expect(activeWorktreePaths.has(fromPathJoin)).toBe(false);
  });
});

describe("cross-source path comparison with toPosix (the fix)", () => {
  const fromGit = "C:/dev/repo/.sandcastle/worktrees/active";
  const fromPathJoin = "C:\\dev\\repo\\.sandcastle\\worktrees\\active";
  const worktreesDirPathJoin = "C:\\dev\\repo\\.sandcastle\\worktrees";

  it("`startsWith` after normalization correctly identifies managed worktrees", () => {
    expect(toPosix(fromGit).startsWith(toPosix(worktreesDirPathJoin))).toBe(
      true,
    );
  });

  it("`Set.has` after normalization correctly identifies active worktrees", () => {
    const activeWorktreePaths = new Set([toPosix(fromGit)]);
    expect(activeWorktreePaths.has(toPosix(fromPathJoin))).toBe(true);
  });

  it("equality after normalization handles the collision-by-path fallback (mid-rebase detached HEAD)", () => {
    // `create` falls back to matching on path when the branch field is null
    // (which happens for worktrees mid-rebase). The two sources must compare
    // equal for the fallback to find the existing worktree.
    expect(toPosix(fromGit) === toPosix(fromPathJoin)).toBe(true);
  });
});
