/**
 * Tests that worktree.interactive() and worktree.run() (from createWorktree())
 * call patchGitMountsForWindows between resolveGitMounts and startSandbox,
 * mirroring the SandboxFactory pattern (ADR-0006).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createWorktree } from "./createWorktree.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import type { BindMountSandboxHandle, ExecResult } from "./SandboxProvider.js";
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

/** Format a minimal stream-json response so the orchestrator parses agent output. */
const toStreamJson = (output: string): string =>
  [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: output }] },
    }),
    JSON.stringify({ type: "result", result: output }),
  ].join("\n");

const makeInteractiveProvider = () =>
  createBindMountSandboxProvider({
    name: "capture-wt-interactive",
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

const makeRunProvider = () =>
  createBindMountSandboxProvider({
    name: "capture-wt-run",
    create: async (options) => {
      const handle: BindMountSandboxHandle = {
        worktreePath: options.worktreePath,
        exec: async (
          command: string,
          execOptions?: {
            cwd?: string;
            onLine?: (line: string) => void;
            sudo?: boolean;
          },
        ): Promise<ExecResult> => {
          if (command.startsWith("claude ")) {
            const stream = toStreamJson("done");
            if (execOptions?.onLine) {
              for (const line of stream.split("\n")) {
                execOptions.onLine(line);
              }
            }
            return { stdout: stream, stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
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

describe("createWorktree() Windows mount patching", () => {
  let hostDir: string;

  afterEach(async () => {
    mockPatchGitMountsForWindows.mockClear();
    if (hostDir) {
      await rm(hostDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("worktree.interactive() calls patchGitMountsForWindows with the worktree path", async () => {
    hostDir = await mkdtemp(join(tmpdir(), "wm-test-wt-interactive-"));
    await initRepo(hostDir);

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "wt-interactive-win" },
      cwd: hostDir,
    });

    const provider = makeInteractiveProvider();

    try {
      await ws.interactive({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: provider,
        prompt: "test",
      });

      expect(mockPatchGitMountsForWindows).toHaveBeenCalledTimes(1);
      const [call] = mockPatchGitMountsForWindows.mock.calls;
      assert.isDefined(call);
      const [gitMounts, worktreePath, sandboxRepoDir] = call;
      expect(Array.isArray(gitMounts)).toBe(true);
      expect(worktreePath).toBe(ws.worktreePath);
      expect(sandboxRepoDir).toBe(SANDBOX_REPO_DIR);
    } finally {
      await ws.close();
    }
  });

  it("worktree.run() calls patchGitMountsForWindows with the worktree path", async () => {
    hostDir = await mkdtemp(join(tmpdir(), "wm-test-wt-run-"));
    await initRepo(hostDir);

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "wt-run-win" },
      cwd: hostDir,
    });

    const provider = makeRunProvider();

    try {
      await ws.run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: provider,
        prompt: "test",
        logging: { type: "stdout" },
      });

      expect(mockPatchGitMountsForWindows).toHaveBeenCalledTimes(1);
      const [call] = mockPatchGitMountsForWindows.mock.calls;
      assert.isDefined(call);
      const [gitMounts, worktreePath, sandboxRepoDir] = call;
      expect(Array.isArray(gitMounts)).toBe(true);
      expect(worktreePath).toBe(ws.worktreePath);
      expect(sandboxRepoDir).toBe(SANDBOX_REPO_DIR);
    } finally {
      await ws.close();
    }
  });
});
