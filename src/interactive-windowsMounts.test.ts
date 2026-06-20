/**
 * Tests that interactive() calls patchGitMountsForWindows between
 * resolveGitMounts and startSandbox for non-head branch strategies on
 * bind-mount providers, mirroring the SandboxFactory pattern (ADR-0006).
 */
import { exec } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

const execAsync = promisify(exec);

const mockPatchGitMountsForWindows = vi.fn(
  (
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
    ) =>
      Effect.succeed(
        mockPatchGitMountsForWindows(gitMounts, worktreePath, sandboxRepoDir),
      ),
  };
});

import { interactive } from "./interactive.js";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
} from "./SandboxProvider.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { claudeCode } from "./AgentProvider.js";

/** A bind-mount provider whose handle executes commands on the host worktree. */
const makeInteractiveProvider = () =>
  createBindMountSandboxProvider({
    name: "capture-interactive",
    create: async (options) => {
      const handle: BindMountSandboxHandle = {
        worktreePath: options.worktreePath,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        interactiveExec: async () => ({ exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      };
      return handle;
    },
  });

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

describe("interactive() Windows mount patching", () => {
  let hostDir: string;

  afterEach(async () => {
    mockPatchGitMountsForWindows.mockClear();
    if (hostDir) {
      await rm(hostDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("calls patchGitMountsForWindows with worktreePath and SANDBOX_REPO_DIR in non-head mode", async () => {
    hostDir = await mkdtemp(join(tmpdir(), "wm-test-interactive-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = makeInteractiveProvider();

    await interactive({
      agent: claudeCode("claude-opus-4-8"),
      sandbox: provider,
      prompt: "test",
      cwd: hostDir,
      branchStrategy: { type: "branch", branch: "interactive-win-branch" },
    });

    expect(mockPatchGitMountsForWindows).toHaveBeenCalledTimes(1);
    const call = mockPatchGitMountsForWindows.mock.calls[0]!;
    const gitMounts = call[0];
    const worktreePath = call[1];
    const sandboxRepoDir = call[2];
    expect(Array.isArray(gitMounts)).toBe(true);
    expect(worktreePath).toContain(".sandcastle/worktrees");
    expect(sandboxRepoDir).toBe(SANDBOX_REPO_DIR);
  });

  it("calls patchGitMountsForWindows with hostRepoDir as worktreeHostPath in head mode", async () => {
    hostDir = await mkdtemp(join(tmpdir(), "wm-test-interactive-head-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = makeInteractiveProvider();

    await interactive({
      agent: claudeCode("claude-opus-4-8"),
      sandbox: provider,
      prompt: "test",
      cwd: hostDir,
      branchStrategy: { type: "head" },
    });

    expect(mockPatchGitMountsForWindows).toHaveBeenCalledTimes(1);
    const call = mockPatchGitMountsForWindows.mock.calls[0]!;
    const worktreePath = call[1];
    const sandboxRepoDir = call[2];
    expect(worktreePath).toBe(hostDir);
    expect(sandboxRepoDir).toBe(SANDBOX_REPO_DIR);
  });
});
