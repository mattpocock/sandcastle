/**
 * Tests that interactive() calls patchGitMountsForWindows between
 * resolveGitMounts and startSandbox for non-head branch strategies on
 * bind-mount providers, mirroring the SandboxFactory pattern (ADR-0006).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { interactive } from "./interactive.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import type { MountEntry } from "./SandboxFactory.js";
import { claudeCode } from "./AgentProvider.js";
import { execAsync } from "./testExec.js";

const mockPatchGitMountsForWindows = vi.fn<
  (
    gitMounts: MountEntry[],
    worktreePath: string,
    sandboxRepoDir: string,
  ) => MountEntry[]
>((gitMounts) => gitMounts);

vi.mock(import("./mountUtils.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    patchGitMountsForWindows: (
      gitMounts: MountEntry[],
      worktreePath: string,
      sandboxRepoDir: string,
    ) =>
      Effect.succeed(
        mockPatchGitMountsForWindows(gitMounts, worktreePath, sandboxRepoDir),
      ),
  };
});

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

/** A git repo on `main` with one commit, of init.txt. */
const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await writeFile(join(dir, "init.txt"), "init");
  await execAsync('git add "init.txt"', { cwd: dir });
  await execAsync('git commit -m "initial commit"', { cwd: dir });
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

    const provider = makeInteractiveProvider();

    await interactive({
      agent: claudeCode("claude-opus-4-8"),
      sandbox: provider,
      prompt: "test",
      cwd: hostDir,
      branchStrategy: { type: "branch", branch: "interactive-win-branch" },
    });

    expect(mockPatchGitMountsForWindows).toHaveBeenCalledTimes(1);
    const [call] = mockPatchGitMountsForWindows.mock.calls;
    assert.isDefined(call);
    const [gitMounts, worktreePath, sandboxRepoDir] = call;
    expect(Array.isArray(gitMounts)).toBe(true);
    expect(worktreePath).toContain(".sandcastle/worktrees");
    expect(sandboxRepoDir).toBe(SANDBOX_REPO_DIR);
  });

  it("calls patchGitMountsForWindows with hostRepoDir as worktreeHostPath in head mode", async () => {
    hostDir = await mkdtemp(join(tmpdir(), "wm-test-interactive-head-"));
    await initRepo(hostDir);

    const provider = makeInteractiveProvider();

    await interactive({
      agent: claudeCode("claude-opus-4-8"),
      sandbox: provider,
      prompt: "test",
      cwd: hostDir,
      branchStrategy: { type: "head" },
    });

    expect(mockPatchGitMountsForWindows).toHaveBeenCalledTimes(1);
    const [call] = mockPatchGitMountsForWindows.mock.calls;
    assert.isDefined(call);
    const [, worktreePath, sandboxRepoDir] = call;
    expect(worktreePath).toBe(hostDir);
    expect(sandboxRepoDir).toBe(SANDBOX_REPO_DIR);
  });
});
