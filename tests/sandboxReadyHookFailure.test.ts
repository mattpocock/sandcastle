import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import {
  createBindMountSandboxProvider,
  createSandbox,
  createWorktree,
} from "@ai-hero/sandcastle";

// A sandbox `onSandboxReady` hook that exits non-zero fails the sandbox:
// createSandbox() and worktree.createSandbox() reject with the hook's command,
// exit code and stderr, and close the sandbox that just started. Without this,
// a failed setup (say, `npm ci`) looks like success and the agent starts in a
// broken environment.

const hooks = {
  sandbox: { onSandboxReady: [{ command: "fail-setup" }] },
} as const;

const failure = "Command failed (exit 7): fail-setup\nsetup failed";

describe("a failing sandbox onSandboxReady hook", () => {
  let repo = "";
  let closes = 0;

  /** A provider whose sandbox fails `fail-setup` with exit 7, and counts closes. */
  const provider = (): SandboxProvider =>
    createBindMountSandboxProvider({
      name: "failing-hook",
      create: async (options) => ({
        worktreePath: options.worktreePath,
        exec: async (command) =>
          command === "fail-setup"
            ? { stdout: "", stderr: "setup failed", exitCode: 7 }
            : { stdout: "", stderr: "", exitCode: 0 },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {
          closes++;
        },
      }),
    });

  beforeEach(() => {
    closes = 0;
    repo = realpathSync.native(mkdtempSync(path.join(tmpdir(), "e2e-hook-")));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# repo\n");
    git("add", ".");
    git("commit", "-m", "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("rejects createSandbox(), closes the sandbox and removes the worktree", async () => {
    await expect(
      createSandbox({
        branch: "failing-hook",
        cwd: repo,
        sandbox: provider(),
        hooks,
      }),
    ).rejects.toThrow(failure);

    expect(closes).toBe(1);
    expect(
      existsSync(path.join(repo, ".sandcastle", "worktrees", "failing-hook")),
    ).toBe(false);
  }, 30_000);

  it("rejects worktree.createSandbox() and closes the sandbox, keeping the worktree", async () => {
    const worktree = await createWorktree({
      branchStrategy: { type: "branch", branch: "failing-hook" },
      cwd: repo,
    });
    try {
      await expect(
        worktree.createSandbox({ sandbox: provider(), hooks }),
      ).rejects.toThrow(failure);

      expect(closes).toBe(1);
      expect(existsSync(worktree.worktreePath)).toBe(true);
    } finally {
      await worktree.close();
    }
  }, 30_000);
});
