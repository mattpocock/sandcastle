import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BindMountCreateOptions } from "@ai-hero/sandcastle";
import {
  claudeCode,
  createBindMountSandboxProvider,
  createSandbox,
  run,
} from "@ai-hero/sandcastle";

// A bind-mount sandbox gets the host repo's .git writable, so the agent can
// commit, but the git control files are mounted again, read-only, at every
// path they are visible at inside the sandbox. The POSIX cases skip Windows,
// where a worktree's .git file is replaced by a patched copy (ADR-0006);
// the last case covers that copy.

type Mount = BindMountCreateOptions["mounts"][number];

const isWindows = process.platform === "win32";

/** A bind-mount provider that records the mounts of the sandbox it creates. */
const recordingProvider = () => {
  let recorded: readonly Mount[] = [];
  const provider = createBindMountSandboxProvider({
    name: "recording",
    create: async (options) => {
      recorded = options.mounts;
      return {
        worktreePath: options.worktreePath,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyFileIn: async () => undefined,
        copyFileOut: async () => undefined,
        close: async () => undefined,
      };
    },
  });
  return { provider, mounts: () => recorded };
};

const readOnlyTargets = (mounts: readonly Mount[]): Set<string> =>
  new Set(mounts.filter((m) => m.readonly === true).map((m) => m.sandboxPath));

describe("bind-mount sandbox git control files", () => {
  let repo = "";

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-git-ctl-")));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "a");
    git("add", ".");
    git("commit", "-m", "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it.skipIf(isWindows)(
    "mounts a worktree's git control files read-only",
    async () => {
      const { provider, mounts } = recordingProvider();
      const sandbox = await createSandbox({
        branch: "w",
        cwd: repo,
        sandbox: provider,
      });
      await sandbox.close();

      const gitDir = path.join(repo, ".git");
      const workspace = mounts().find(
        (m) => m.hostPath === path.join(repo, ".sandcastle", "worktrees", "w"),
      )?.sandboxPath;
      expect(readOnlyTargets(mounts())).toStrictEqual(
        new Set([
          `${workspace}/.git`,
          path.join(gitDir, "config"),
          path.join(gitDir, "hooks"),
          path.join(gitDir, "info"),
          path.join(gitDir, "worktrees", "w", "commondir"),
        ]),
      );
    },
  );

  it.skipIf(isWindows)(
    "leaves the rest of the worktree's .git writable",
    async () => {
      const { provider, mounts } = recordingProvider();
      const sandbox = await createSandbox({
        branch: "w",
        cwd: repo,
        sandbox: provider,
      });
      await sandbox.close();

      const gitDir = path.join(repo, ".git");
      expect(
        mounts().find((m) => m.hostPath === gitDir)?.readonly,
      ).toBeUndefined();
    },
  );

  it.skipIf(isWindows)(
    "mounts the .git file read-only when run from a linked worktree in head mode",
    async () => {
      const linked = path.join(repo, "linked");
      execFileSync("git", ["worktree", "add", "-b", "linked", linked], {
        cwd: repo,
        stdio: "ignore",
      });
      const { provider, mounts } = recordingProvider();
      await run({
        agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
        sandbox: provider,
        cwd: linked,
        prompt: "Finish the task.",
        branchStrategy: { type: "head" },
        logging: {
          type: "file",
          path: path.join(tmpdir(), `${path.basename(repo)}-linked.log`),
        },
      });

      const dotGit = path.join(linked, ".git");
      expect(mounts().find((m) => m.sandboxPath === dotGit)).toStrictEqual({
        hostPath: dotGit,
        sandboxPath: dotGit,
        readonly: true,
      });
    },
  );

  it.skipIf(isWindows)(
    "covers the repo's .git at every path it is visible at in head mode",
    async () => {
      const { provider, mounts } = recordingProvider();
      await run({
        agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
        sandbox: provider,
        cwd: repo,
        prompt: "Finish the task.",
        branchStrategy: { type: "head" },
        logging: {
          type: "file",
          path: path.join(tmpdir(), `${path.basename(repo)}.log`),
        },
      });

      const workspace = mounts().find((m) => m.hostPath === repo)?.sandboxPath;
      expect(readOnlyTargets(mounts())).toStrictEqual(
        new Set([
          `${workspace}/.git/config`,
          `${workspace}/.git/hooks`,
          `${workspace}/.git/info`,
          path.join(repo, ".git", "config"),
          path.join(repo, ".git", "hooks"),
          path.join(repo, ".git", "info"),
        ]),
      );
    },
  );

  it("mounts the worktree's .git file read-only on every platform", async () => {
    const { provider, mounts } = recordingProvider();
    const sandbox = await createSandbox({
      branch: "w",
      cwd: repo,
      sandbox: provider,
    });
    await sandbox.close();

    const workspace = mounts()[0]?.sandboxPath;
    expect(
      mounts().find((m) => m.sandboxPath === `${workspace}/.git`)?.readonly,
    ).toBe(true);
  });
});
