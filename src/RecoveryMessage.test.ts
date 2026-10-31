import { describe, expect, it } from "vitest";
import { buildRecoveryMessage } from "./RecoveryMessage.js";

describe("buildRecoveryMessage", () => {
  const patchDir = ".sandcastle/patches/20260324-153000";

  it("reverses the previous diff before applying only the numbered commit patches", () => {
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "previousDiff",
      hasPreviousDiff: true,
      hasCommits: true,
      hasDiff: true,
      hasUntracked: true,
    });
    expect(msg).toContain(
      "Patch application failed at step 1 (previously synced uncommitted changes).",
    );
    expect(msg).toContain(`git apply --reverse ${patchDir}/previous.diff`);
    expect(msg).toContain(`git am --3way ${patchDir}/[0-9]*.patch`);
    expect(msg).toContain(`git apply ${patchDir}/changes.patch`);
    expect(msg).toContain(`cp -r ${patchDir}/untracked/* .`);
    expect(msg).not.toContain("git am --continue");
  });

  it("does not repeat a successful reversal after a later diff failure", () => {
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "diff",
      hasPreviousDiff: true,
      hasCommits: true,
      hasDiff: true,
      hasUntracked: false,
    });
    expect(msg).toContain(
      "Patch application failed at step 3 (uncommitted changes).",
    );
    expect(msg).toContain(`git apply ${patchDir}/changes.patch`);
    expect(msg).not.toContain("--reverse");
    expect(msg).not.toContain("git am");
  });

  it("git am failure with remaining diff and untracked steps", () => {
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "commits",
      hasCommits: true,
      hasDiff: true,
      hasUntracked: true,
    });

    expect(msg).toContain(
      "Patch application failed at step 1 (committed changes).",
    );
    expect(msg).toContain("git am --continue");
    expect(msg).toContain(`git apply ${patchDir}/changes.patch`);
    expect(msg).toContain(`cp -r ${patchDir}/untracked/* .`);
  });

  it("git am failure with no remaining steps", () => {
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "commits",
      hasCommits: true,
      hasDiff: false,
      hasUntracked: false,
    });

    expect(msg).toContain(
      "Patch application failed at step 1 (committed changes).",
    );
    expect(msg).toContain("git am --continue");
    expect(msg).not.toContain("git apply");
    expect(msg).not.toContain("cp -r");
  });

  it("git apply failure with untracked remaining", () => {
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "diff",
      hasCommits: true,
      hasDiff: true,
      hasUntracked: true,
    });

    // Commits already applied, so no git am instructions
    expect(msg).toContain(
      "Patch application failed at step 2 (uncommitted changes).",
    );
    expect(msg).not.toContain("git am");
    expect(msg).toContain(`git apply ${patchDir}/changes.patch`);
    expect(msg).toContain(`cp -r ${patchDir}/untracked/* .`);
  });

  it("git apply failure with no untracked files", () => {
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "diff",
      hasCommits: false,
      hasDiff: true,
      hasUntracked: false,
    });

    expect(msg).toContain(
      "Patch application failed at step 1 (uncommitted changes).",
    );
    expect(msg).toContain(`git apply ${patchDir}/changes.patch`);
    expect(msg).not.toContain("cp -r");
  });

  it("untracked copy failure", () => {
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "untracked",
      hasCommits: true,
      hasDiff: true,
      hasUntracked: true,
    });

    // Commits and diff already applied
    expect(msg).toContain(
      "Patch application failed at step 3 (untracked files).",
    );
    expect(msg).not.toContain("git am");
    expect(msg).not.toContain("git apply");
    expect(msg).toContain(`cp -r ${patchDir}/untracked/* .`);
  });

  it("omits steps with no artifacts", () => {
    // Only diff, no commits or untracked
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "diff",
      hasCommits: false,
      hasDiff: true,
      hasUntracked: false,
    });

    expect(msg).not.toContain("git am");
    expect(msg).not.toContain("cp -r");
    expect(msg).toContain("git apply");
  });

  it("paths are relative to repo root", () => {
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "commits",
      hasCommits: true,
      hasDiff: true,
      hasUntracked: true,
    });

    // All paths should use patchDir directly, no absolute paths
    expect(msg).not.toMatch(/\/tmp\//);
    expect(msg).not.toMatch(/\/home\//);
    expect(msg).toContain(patchDir);
  });

  it("git am failure shows remaining steps as follow-up", () => {
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "commits",
      hasCommits: true,
      hasDiff: true,
      hasUntracked: true,
    });

    // Should show remaining steps after git am resolves
    expect(msg).toContain(
      "After all commits are applied, run the remaining steps:",
    );
    expect(msg).toContain(`git apply ${patchDir}/changes.patch && \\`);
    expect(msg).toContain(`cp -r ${patchDir}/untracked/* .`);
  });

  it("git am failure with only diff remaining shows single follow-up", () => {
    const msg = buildRecoveryMessage({
      patchDir,
      failedStep: "commits",
      hasCommits: true,
      hasDiff: true,
      hasUntracked: false,
    });

    expect(msg).toContain(
      "After all commits are applied, run the remaining steps:",
    );
    expect(msg).toContain(`git apply ${patchDir}/changes.patch`);
    expect(msg).not.toContain("&& \\");
  });

  describe("--branch recovery commands", () => {
    const branch = "feature/test";

    it("git am failure includes worktree setup", () => {
      const msg = buildRecoveryMessage({
        patchDir,
        failedStep: "commits",
        hasCommits: true,
        hasDiff: false,
        hasUntracked: false,
        branch,
      });

      expect(msg).toContain(
        "git worktree add .sandcastle/worktree feature/test",
      );
      expect(msg).toContain("cd .sandcastle/worktree");
      expect(msg).toContain("git am --continue");
    });

    it("git am failure with remaining steps uses worktree-relative paths", () => {
      const msg = buildRecoveryMessage({
        patchDir,
        failedStep: "commits",
        hasCommits: true,
        hasDiff: true,
        hasUntracked: true,
        branch,
      });

      expect(msg).toContain(
        "git worktree add .sandcastle/worktree feature/test",
      );
      // Remaining steps should reference paths relative to worktree
      expect(msg).toContain(`git apply ../../${patchDir}/changes.patch`);
      expect(msg).toContain(`cp -r ../../${patchDir}/untracked/* .`);
    });

    it("diff failure includes worktree setup and correct paths", () => {
      const msg = buildRecoveryMessage({
        patchDir,
        failedStep: "diff",
        hasCommits: true,
        hasDiff: true,
        hasUntracked: true,
        branch,
      });

      // Commits already applied, but still need worktree for remaining steps
      expect(msg).toContain(
        "git worktree add .sandcastle/worktree feature/test",
      );
      expect(msg).toContain(`git apply ../../${patchDir}/changes.patch`);
      expect(msg).toContain(`cp -r ../../${patchDir}/untracked/* .`);
    });

    it("omits worktree setup when branch is undefined (direct-apply)", () => {
      const msg = buildRecoveryMessage({
        patchDir,
        failedStep: "commits",
        hasCommits: true,
        hasDiff: false,
        hasUntracked: false,
      });

      expect(msg).not.toContain("worktree");
    });
  });
});
