import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { git } from "./git.js";

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
      "importPatchesCommand",
      "diffWorkingTreeCommand",
      "applyPatchCommand",
      "listUntrackedCommand",
      "detachCheckout",
      "mergeBranchInto",
      "deleteBranch",
      "resolveRepoMounts",
      "recoveryInstructions",
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
      `git format-patch "abc..HEAD" -o "/tmp/p"`,
    );
  });
  it("builds the apply command", () => {
    expect(git().applyPatchCommand({ patchPath: "/tmp/x.patch" })).toBe(
      `git apply "/tmp/x.patch"`,
    );
  });
  it("builds the import patches command", () => {
    expect(git().importPatchesCommand({ patchDir: "/tmp/patches" })).toBe(
      `git am --3way "/tmp/patches"/*.patch`,
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
});

describe("git() recovery instructions", () => {
  it("builds a recovery instruction string for git", () => {
    const out = git().recoveryInstructions({
      patchDir: "/tmp/x",
      targetBranch: "main",
    });
    expect(out).toContain("git checkout main");
    expect(out).toContain("git am --3way /tmp/x/*.patch");
    expect(out).toContain("git apply /tmp/x/changes.patch");
  });
});
