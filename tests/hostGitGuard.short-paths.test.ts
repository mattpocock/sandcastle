import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree } from "@ai-hero/sandcastle";

const isWindows = process.platform === "win32";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  }).trim();

/** Query an actual filesystem alias, not a fabricated path containing '~'. */
const shortPath = (value: string): string => {
  const result = spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", 'for %I in ("%SANDCASTLE_SHORT_PATH%") do @echo %~sI'],
    {
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: 10_000,
      env: { ...process.env, SANDCASTLE_SHORT_PATH: value },
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
};

// Git marks .git hidden on Windows; unlink the fixture before replacing it
// because opening a hidden file with O_TRUNC fails even when it is writable.
const replacePointer = (file: string, text: string): void => {
  rmSync(file);
  writeFileSync(file, text, { flag: "wx" });
};

const rewriteGitdir = (worktree: string, alias: string): void => {
  replacePointer(
    path.join(worktree, ".git"),
    `gitdir: ${path.join(alias, "repo", ".git", "worktrees", "feature")}\n`,
  );
};

const rewriteCommondir = (_worktree: string, alias: string): void => {
  writeFileSync(
    path.join(alias, "repo", ".git", "worktrees", "feature", "commondir"),
    `${path.join(alias, "repo", ".git")}\n`,
  );
};

describe.skipIf(!isWindows)(
  "host git guard with Windows short paths",
  { timeout: 30_000 },
  () => {
    let root = "";
    let alias = "";
    let repo = "";

    beforeEach((ctx) => {
      root = realpathSync.native(
        mkdtempSync(path.join(tmpdir(), "e2e-short-git-path-")),
      );
      alias = shortPath(root);
      if (alias === root) {
        ctx.skip(); // Some Windows volumes disable 8.3 filename creation.
      }
      if (realpathSync.native(alias) !== root) {
        throw new Error("The short-path fixture must name the same directory");
      }
      repo = path.join(root, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(path.join(repo, "README.md"), "repo\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "init");
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("creates and reuses a worktree from an 8.3 cwd without losing edits", async () => {
      const cwd = path.join(alias, "repo");
      const first = await createWorktree({
        branchStrategy: { type: "branch", branch: "feature" },
        cwd,
      });
      try {
        writeFileSync(path.join(first.worktreePath, "kept.txt"), "keep me\n");
        const second = await createWorktree({
          branchStrategy: { type: "branch", branch: "feature" },
          cwd,
        });
        try {
          expect(realpathSync.native(second.worktreePath)).toBe(
            realpathSync.native(first.worktreePath),
          );
          expect(
            readFileSync(path.join(second.worktreePath, "kept.txt"), "utf8"),
          ).toBe("keep me\n");
          expect(git(second.worktreePath, "branch", "--show-current")).toBe(
            "feature",
          );
        } finally {
          await second.close();
        }
      } finally {
        await first.close();
      }
    });

    it("does not prune a live worktree when creating another from an 8.3 cwd", async () => {
      const first = await createWorktree({
        branchStrategy: { type: "branch", branch: "feature" },
        cwd: repo,
      });
      try {
        writeFileSync(path.join(first.worktreePath, "kept.txt"), "keep me\n");
        const second = await createWorktree({
          branchStrategy: { type: "branch", branch: "another" },
          cwd: path.join(alias, "repo"),
        });
        try {
          expect(
            readFileSync(path.join(first.worktreePath, "kept.txt"), "utf8"),
          ).toBe("keep me\n");
          expect(git(first.worktreePath, "branch", "--show-current")).toBe(
            "feature",
          );
          expect(git(second.worktreePath, "branch", "--show-current")).toBe(
            "another",
          );
        } finally {
          await second.close();
        }
      } finally {
        await first.close();
      }
    });

    it("reuses a clean worktree from an 8.3 cwd", async () => {
      const first = await createWorktree({
        branchStrategy: { type: "branch", branch: "feature" },
        cwd: path.join(alias, "repo"),
      });
      try {
        const second = await createWorktree({
          branchStrategy: { type: "branch", branch: "feature" },
          cwd: path.join(alias, "repo"),
        });
        try {
          expect(realpathSync.native(second.worktreePath)).toBe(
            realpathSync.native(first.worktreePath),
          );
          expect(
            readFileSync(
              path.join(second.worktreePath, "README.md"),
              "utf8",
            ).trim(),
          ).toBe("repo");
        } finally {
          await second.close();
        }
      } finally {
        await first.close();
      }
    });

    it("creates and closes a merge-to-head worktree from an 8.3 cwd", async () => {
      const wt = await createWorktree({
        branchStrategy: { type: "merge-to-head" },
        cwd: path.join(alias, "repo"),
      });
      try {
        expect(git(wt.worktreePath, "branch", "--show-current")).toBe(
          wt.branch,
        );
        expect(git(wt.worktreePath, "rev-parse", "HEAD")).toBe(
          git(repo, "rev-parse", "HEAD"),
        );
      } finally {
        await wt.close();
      }
      expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
        wt.branch,
      );
      expect(git(repo, "branch", "--list", wt.branch)).toBe("");
    });

    it.each([
      { pointer: "gitdir", rewrite: rewriteGitdir },
      { pointer: "commondir", rewrite: rewriteCommondir },
    ])(
      "accepts an equivalent 8.3 $pointer pointer on reuse",
      async ({ rewrite }) => {
        const first = await createWorktree({
          branchStrategy: { type: "branch", branch: "feature" },
          cwd: repo,
        });
        try {
          rewrite(first.worktreePath, alias);
          const second = await createWorktree({
            branchStrategy: { type: "branch", branch: "feature" },
            cwd: repo,
          });
          try {
            expect(second.worktreePath).toBe(first.worktreePath);
            expect(git(second.worktreePath, "status", "--porcelain")).toBe("");
          } finally {
            await second.close();
          }
        } finally {
          await first.close();
        }
      },
    );

    it("still refuses an 8.3 pointer into a different repository", async () => {
      const other = path.join(root, "other");
      mkdirSync(other);
      git(other, "init", "-q", "-b", "main");
      const otherAdmin = path.join(other, ".git", "worktrees", "feature");
      mkdirSync(otherAdmin, { recursive: true });
      writeFileSync(path.join(otherAdmin, "commondir"), "../..\n");
      const first = await createWorktree({
        branchStrategy: { type: "branch", branch: "feature" },
        cwd: repo,
      });
      const dotGit = path.join(first.worktreePath, ".git");
      const original = readFileSync(dotGit, "utf8");
      try {
        replacePointer(
          dotGit,
          `gitdir: ${path.join(alias, "other", ".git", "worktrees", "feature")}\n`,
        );
        await expect(
          createWorktree({
            branchStrategy: { type: "branch", branch: "feature" },
            cwd: repo,
          }),
        ).rejects.toThrow(/Refusing to run git on the host/u);
      } finally {
        replacePointer(dotGit, original);
        await first.close();
      }
    });
  },
);
