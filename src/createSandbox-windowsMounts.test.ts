/**
 * Tests that createSandbox and createSandboxFromWorktree call
 * patchGitMountsForWindows between resolveGitMounts and startSandbox,
 * mirroring the SandboxFactory pattern (ADR-0006).
 */
import { exec } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const execAsync = promisify(exec);

// Mock patchGitMountsForWindows to track calls
const mockPatchGitMountsForWindows = vi.fn(
  async (
    gitMounts: Array<{ hostPath: string; sandboxPath: string }>,
    _worktreePath: string,
    _sandboxRepoDir: string,
  ) => gitMounts,
);

vi.mock("./mountUtils.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    patchGitMountsForWindows: (
      gitMounts: Array<{ hostPath: string; sandboxPath: string }>,
      worktreePath: string,
      sandboxRepoDir: string,
    ) => mockPatchGitMountsForWindows(gitMounts, worktreePath, sandboxRepoDir),
  };
});

import { createSandbox, createSandboxFromWorktree } from "./createSandbox.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";

/** A bind-mount provider that captures mounts without starting a real container */
const captureMountsProvider = () => {
  let capturedMounts: Array<{
    hostPath: string;
    sandboxPath: string;
    readonly?: boolean;
  }> = [];
  const provider = createBindMountSandboxProvider({
    name: "capture-mounts",
    create: async (opts) => {
      capturedMounts = [...opts.mounts];
      return {
        worktreePath: SANDBOX_REPO_DIR,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      };
    },
  });
  return { provider, getCapturedMounts: () => capturedMounts };
};

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

describe("createSandbox Windows mount patching", () => {
  let hostDir: string;

  afterEach(async () => {
    mockPatchGitMountsForWindows.mockClear();
    if (hostDir) {
      await rm(hostDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("createSandbox calls patchGitMountsForWindows with worktreePath and SANDBOX_REPO_DIR", async () => {
    hostDir = await mkdtemp(join(tmpdir(), "wm-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const { provider } = captureMountsProvider();

    const sandbox = await createSandbox({
      branch: "test-windows-patch",
      sandbox: provider,
      cwd: hostDir,
    });

    try {
      expect(mockPatchGitMountsForWindows).toHaveBeenCalledTimes(1);
      const call = mockPatchGitMountsForWindows.mock.calls[0]!;
      const gitMounts = call[0];
      const calledWorktreePath = call[1];
      const sandboxRepoDir = call[2];
      // gitMounts should be an array (possibly empty if no parent .git)
      expect(Array.isArray(gitMounts)).toBe(true);
      // worktreePath should be the created worktree path
      expect(calledWorktreePath).toContain(".sandcastle/worktrees");
      // sandboxRepoDir should be the canonical sandbox dir
      expect(sandboxRepoDir).toBe(SANDBOX_REPO_DIR);
    } finally {
      await sandbox.close();
    }
  });

  it("createSandboxFromWorktree calls patchGitMountsForWindows", async () => {
    hostDir = await mkdtemp(join(tmpdir(), "wm-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    // Create a worktree to pass to createSandboxFromWorktree
    const worktreePath = join(hostDir, ".sandcastle", "worktrees", "test-wt");
    await execAsync(`git worktree add "${worktreePath}" -b test-wt-branch`, {
      cwd: hostDir,
    });

    const { provider } = captureMountsProvider();

    const sandbox = await createSandboxFromWorktree({
      branch: "test-wt-branch",
      worktreePath,
      hostRepoDir: hostDir,
      sandbox: provider,
    });

    try {
      expect(mockPatchGitMountsForWindows).toHaveBeenCalledTimes(1);
      const call = mockPatchGitMountsForWindows.mock.calls[0]!;
      const gitMounts = call[0];
      const patchWorktreePath = call[1];
      const sandboxRepoDir = call[2];
      expect(Array.isArray(gitMounts)).toBe(true);
      expect(patchWorktreePath).toBe(worktreePath);
      expect(sandboxRepoDir).toBe(SANDBOX_REPO_DIR);
    } finally {
      await sandbox.close();
    }
  });
});
