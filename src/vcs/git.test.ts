import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { git, shellSingleQuote } from "./git.js";

describe("shellSingleQuote", () => {
  it("wraps simple input in single quotes", () => {
    expect(shellSingleQuote("hello")).toBe("'hello'");
  });
  it("escapes embedded single quote with the POSIX trick", () => {
    expect(shellSingleQuote("O'Brien")).toBe(`'O'\\''Brien'`);
  });
  it("does not expand $() or backticks", () => {
    expect(shellSingleQuote("$(rm -rf /)")).toBe(`'$(rm -rf /)'`);
    expect(shellSingleQuote("`bad`")).toBe(`'\`bad\`'`);
  });
  it("handles empty string", () => {
    expect(shellSingleQuote("")).toBe("''");
  });
});

describe("git() factory", () => {
  it("returns a provider tagged 'git'", () => {
    const provider = git();
    expect(provider.tag).toBe("git");
  });

  it("exposes all VersionControlProvider methods", () => {
    const provider = git();
    const expectedMethods = [
      "createCheckout",
      "removeCheckout",
      "pruneStaleCheckouts",
      "hasUncommittedChanges",
      "currentBranch",
      "headRef",
      "commitsBetween",
      "readUserIdentity",
      "writeUserIdentityCommands",
      "bundleAllRefs",
      "cloneFromBundleCommands",
      "exportPatchesCommand",
      "diffWorkingTreeCommand",
      "applyPatchCommand",
      "listUntrackedCommand",
      "detachCheckout",
      "mergeBranchInto",
      "deleteBranch",
      "resolveRepoMounts",
      "recoveryInstructions",
      "mergeFailureHint",
    ] as const;

    for (const method of expectedMethods) {
      expect(
        typeof (provider as unknown as Record<string, unknown>)[method],
      ).toBe("function");
    }
  });
});

describe("git() worktree lifecycle (real git)", () => {
  it("creates, queries, and removes a checkout", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "vcs-git-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });
      writeFileSync(join(repoDir, "README"), "x\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

      const provider = git();
      const checkout = await provider.createCheckout({ repoDir });
      expect(checkout.path).toMatch(/sandcastle\/worktrees/);
      expect(typeof checkout.branch).toBe("string");

      const dirty = await provider.hasUncommittedChanges(checkout.path);
      expect(dirty).toBe(false);

      writeFileSync(join(checkout.path, "scratch"), "y\n");
      const dirtyAfter = await provider.hasUncommittedChanges(checkout.path);
      expect(dirtyAfter).toBe(true);

      // Clean up the dirty file before remove (mirrors WorktreeManager precondition)
      rmSync(join(checkout.path, "scratch"));
      await provider.removeCheckout(checkout.path);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("git().headRef", () => {
  it("returns the 40-char SHA of HEAD", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "vcs-git-headref-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });
      writeFileSync(join(repoDir, "README"), "x\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

      const sha = await git().headRef(repoDir);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("git().writeUserIdentityCommands", () => {
  it("emits one command per non-empty field", () => {
    expect(
      git().writeUserIdentityCommands({ name: "Ada", email: "a@b" }),
    ).toEqual([
      `git config --global user.name 'Ada'`,
      `git config --global user.email 'a@b'`,
    ]);
  });
  it("escapes embedded single quotes", () => {
    expect(git().writeUserIdentityCommands({ name: "A'B", email: "" })).toEqual(
      ["git config --global user.name 'A'\\''B'"],
    );
  });
  it("returns empty when both fields are empty", () => {
    expect(git().writeUserIdentityCommands({ name: "", email: "" })).toEqual(
      [],
    );
  });
  it("escapes shell metacharacters safely", () => {
    expect(
      git().writeUserIdentityCommands({
        name: "Alice$(rm -rf /);`bad`",
        email: "",
      }),
    ).toEqual([`git config --global user.name 'Alice$(rm -rf /);\`bad\`'`]);
  });
});

describe("git().cloneFromBundleCommands", () => {
  it("uses single-quote escaping for all interpolated paths", () => {
    const cmds = git().cloneFromBundleCommands({
      bundlePath: "/tmp/b",
      targetPath: "/work",
      branch: "main",
    });
    expect(cmds[0]).toBe(`git clone '/tmp/b' '/work_clone'`);
    expect(cmds[1]).toBe(`rm -rf '/work' && mv '/work_clone' '/work'`);
    expect(cmds[2]).toBe(`cd '/work' && git checkout 'main'`);
  });
  it("escapes shell metacharacters in branch names", () => {
    const cmds = git().cloneFromBundleCommands({
      bundlePath: "/tmp/b",
      targetPath: "/work",
      branch: "main; rm -rf /",
    });
    expect(cmds[2]).toBe(`cd '/work' && git checkout 'main; rm -rf /'`);
  });
});

describe("git() transport command builders", () => {
  it("builds the format-patch command", () => {
    expect(git().exportPatchesCommand({ base: "abc", outDir: "/tmp/p" })).toBe(
      `git format-patch 'abc..HEAD' -o '/tmp/p'`,
    );
  });
  it("builds the apply command", () => {
    expect(git().applyPatchCommand({ patchPath: "/tmp/x.patch" })).toBe(
      `git apply '/tmp/x.patch'`,
    );
  });
  it("builds diff working tree command", () => {
    expect(git().diffWorkingTreeCommand()).toBe(`git diff HEAD`);
  });
  it("builds list untracked command", () => {
    expect(git().listUntrackedCommand()).toBe(
      `git ls-files --others --exclude-standard`,
    );
  });
  it("escapes $() injection in exportPatchesCommand", () => {
    expect(
      git().exportPatchesCommand({ base: "$(rm -rf /)", outDir: "/tmp/p" }),
    ).toBe(`git format-patch '$(rm -rf /)..HEAD' -o '/tmp/p'`);
  });
  it("escapes backtick injection in applyPatchCommand", () => {
    expect(git().applyPatchCommand({ patchPath: "`evil`" })).toBe(
      `git apply '\`evil\`'`,
    );
  });
  it("escapes single quotes in applyPatchCommand", () => {
    expect(git().applyPatchCommand({ patchPath: "/tmp/O'Brien.patch" })).toBe(
      `git apply '/tmp/O'\\''Brien.patch'`,
    );
  });
});

describe("git().mergeBranchInto (real git)", () => {
  it("merges a feature branch into the current branch", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "vcs-merge-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });
      writeFileSync(join(repoDir, "README"), "x\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

      // Capture the initial branch name (could be main or master)
      const initialBranch = execFileSync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: repoDir },
      )
        .toString()
        .trim();

      // Create feature branch with a commit
      execFileSync("git", ["checkout", "-q", "-b", "feature"], {
        cwd: repoDir,
      });
      writeFileSync(join(repoDir, "feature-file"), "y\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "feature work"], { cwd: repoDir });

      // Switch back to initial branch
      execFileSync("git", ["checkout", "-q", initialBranch], { cwd: repoDir });

      // Merge feature into current
      const provider = git();
      await provider.mergeBranchInto({
        repoDir,
        sourceBranch: "feature",
        targetBranch: initialBranch,
      });

      // Verify feature-file now exists on the main/master branch
      expect(existsSync(join(repoDir, "feature-file"))).toBe(true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("git().deleteBranch (real git)", () => {
  it("deletes a branch from the repo", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "vcs-delbranch-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });
      writeFileSync(join(repoDir, "README"), "x\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

      // Create a branch
      execFileSync("git", ["branch", "to-delete"], { cwd: repoDir });

      // Verify it exists
      const before = execFileSync("git", ["branch", "--list", "to-delete"], {
        cwd: repoDir,
      })
        .toString()
        .trim();
      expect(before).toContain("to-delete");

      // Delete via provider
      await git().deleteBranch(repoDir, "to-delete");

      // Verify it's gone
      const after = execFileSync("git", ["branch", "--list", "to-delete"], {
        cwd: repoDir,
      })
        .toString()
        .trim();
      expect(after).toBe("");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("git().detachCheckout (real git)", () => {
  it("puts the checkout into detached HEAD state", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "vcs-detach-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });
      writeFileSync(join(repoDir, "README"), "x\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

      // Verify on a branch (not detached)
      const before = execFileSync("git", ["symbolic-ref", "-q", "HEAD"], {
        cwd: repoDir,
      })
        .toString()
        .trim();
      expect(before).toMatch(/^refs\/heads\//);

      // Detach
      await git().detachCheckout(repoDir);

      // Verify detached: symbolic-ref exits non-zero on detached HEAD
      let isDetached = false;
      try {
        execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: repoDir });
      } catch {
        isDetached = true;
      }
      expect(isDetached).toBe(true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("git().commitsBetween (real git)", () => {
  it("returns the commits between two refs in chronological order", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "vcs-commitsbetween-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });
      writeFileSync(join(repoDir, "f1"), "1\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "first"], { cwd: repoDir });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
      })
        .toString()
        .trim();

      writeFileSync(join(repoDir, "f2"), "2\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "second"], { cwd: repoDir });

      writeFileSync(join(repoDir, "f3"), "3\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "third"], { cwd: repoDir });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
      })
        .toString()
        .trim();

      const commits = await git().commitsBetween(repoDir, baseSha, headSha);

      expect(commits).toHaveLength(2);
      // Each commit has an `id` (SHA) field; both should be valid hex SHAs
      for (const c of commits) {
        expect(c.id).toMatch(/^[0-9a-f]{40}$/);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when base equals head", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "vcs-commitsbetween-empty-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });
      writeFileSync(join(repoDir, "f"), "x\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "only"], { cwd: repoDir });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
      })
        .toString()
        .trim();

      const commits = await git().commitsBetween(repoDir, sha, sha);
      expect(commits).toEqual([]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("git().mergeFailureHint", () => {
  it("returns git-specific retry instructions", () => {
    const hint = git().mergeFailureHint({
      sourceBranch: "feature/abc",
      targetBranch: "main",
    });
    expect(hint).toContain("git merge feature/abc");
    expect(hint).toContain("git branch -D feature/abc");
  });
});

describe("git() recovery instructions", () => {
  it("builds a recovery instruction string for git", () => {
    const out = git().recoveryInstructions({
      patchDir: "/tmp/x",
      targetBranch: "main",
    });
    expect(out).toContain("git checkout 'main'");
    expect(out).toContain("git am --3way '/tmp/x'/*.patch");
    expect(out).toContain("git apply '/tmp/x'/changes.patch");
  });
  it("escapes $() injection in patchDir", () => {
    const out = git().recoveryInstructions({
      patchDir: "$(rm -rf /)",
      targetBranch: "main",
    });
    expect(out).toContain(`git am --3way '$(rm -rf /)'/*.patch`);
    expect(out).toContain(`git apply '$(rm -rf /)'/changes.patch`);
  });
  it("escapes $() injection in targetBranch", () => {
    const out = git().recoveryInstructions({
      patchDir: "/tmp/x",
      targetBranch: "$(evil)",
    });
    expect(out).toContain(`git checkout '$(evil)'`);
  });
});
