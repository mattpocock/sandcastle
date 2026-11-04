/**
 * On Windows, `patchGitMountsForWindows` writes the worktree's corrected
 * `.git` file into a `sandcastle-git-*` temp dir. These tests force the
 * Windows path on any host and check that the temp dir is removed when the
 * sandbox closes, or fails to start.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MountEntry } from "./SandboxFactory.js";

const tempDirs: string[] = [];

vi.mock(import("./mountUtils.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    patchGitMountsForWindows: (
      gitMounts: MountEntry[],
      worktreePath: string,
      sandboxRepoDir: string,
    ) =>
      actual
        .patchGitMountsForWindows(
          gitMounts,
          worktreePath,
          sandboxRepoDir,
          undefined,
          undefined,
          "win32",
        )
        .pipe(
          Effect.tap((mounts) => {
            for (const m of mounts) {
              if (m.tempDir !== undefined) {
                tempDirs.push(m.tempDir);
              }
            }
          }),
        ),
  };
});

const { createSandbox, createSandboxFromWorktree } = await import(
  "./createSandbox.js"
);
const { createBindMountSandboxProvider } = await import("./SandboxProvider.js");
const { SANDBOX_REPO_DIR } = await import("./SandboxFactory.js");

const provider = (options?: { failCreate?: boolean }) =>
  createBindMountSandboxProvider({
    name: "fake",
    create: async () => {
      if (options?.failCreate === true) {
        throw new Error("create failed");
      }
      return {
        worktreePath: SANDBOX_REPO_DIR,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      };
    },
  });

const repos: string[] = [];

const sh = (cmd: string, cwd: string) => {
  execSync(cmd, { cwd, stdio: "ignore" });
};

const makeRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), "win-override-"));
  repos.push(repo);
  sh("git init -q -b main", repo);
  writeFileSync(join(repo, "a.txt"), "a");
  sh("git add a.txt && git commit -q -m init", repo);
  return repo;
};

/** Whether the one temp dir the patch created still exists. */
const tempDirExists = () => {
  expect(tempDirs).toHaveLength(1);
  return tempDirs.some((dir) => existsSync(dir));
};

describe("Windows .git override temp dir", () => {
  beforeEach(() => {
    tempDirs.length = 0;
  });

  afterEach(() => {
    for (const repo of repos.splice(0)) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is removed when a createSandbox() sandbox closes", async () => {
    const repo = makeRepo();
    const sandbox = await createSandbox({
      branch: "win-override",
      sandbox: provider(),
      cwd: repo,
    });
    expect(tempDirExists()).toBe(true);

    await sandbox.close();

    expect(tempDirExists()).toBe(false);
  });

  it("is removed when a worktree's sandbox closes", async () => {
    const repo = makeRepo();
    const worktreePath = join(repo, ".sandcastle", "worktrees", "wt");
    sh(`git worktree add -q -b wt "${worktreePath}"`, repo);
    const sandbox = await createSandboxFromWorktree({
      branch: "wt",
      worktreePath,
      hostRepoDir: repo,
      sandbox: provider(),
    });
    expect(tempDirExists()).toBe(true);

    await sandbox.close();

    expect(tempDirExists()).toBe(false);
  });

  it("is removed when the sandbox fails to start", async () => {
    const repo = makeRepo();

    await expect(
      createSandbox({
        branch: "win-override-fail",
        sandbox: provider({ failCreate: true }),
        cwd: repo,
      }),
    ).rejects.toThrow(/create failed/u);

    expect(tempDirExists()).toBe(false);
  });
});
