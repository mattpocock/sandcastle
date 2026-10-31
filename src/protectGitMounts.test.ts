import { Effect } from "effect";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchGitMountsForWindows, removeMountTempDirs } from "./mountUtils.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import type { BindMountCreateOptions } from "./SandboxProvider.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import { startSandbox } from "./startSandbox.js";

type Mount = BindMountCreateOptions["mounts"][number];

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

const sh = (cmd: string, cwd: string) => {
  execSync(cmd, { cwd, stdio: "ignore" });
};

const makeRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "protect-git-")));
  repos.push(repo);
  sh("git init -q -b main", repo);
  writeFileSync(join(repo, "a.txt"), "a");
  sh("git add a.txt && git commit -q -m init", repo);
  return repo;
};

const makeWorktree = (repo: string) => {
  const worktree = join(repo, ".sandcastle", "worktrees", "w");
  sh(`git worktree add -q -b w "${worktree}"`, repo);
  return worktree;
};

/** A bind-mount provider that records the mounts of its one sandbox. */
const recordingProvider = () => {
  let recorded: Mount[] = [];
  const provider = createBindMountSandboxProvider({
    name: "recording",
    create: async (createOptions) => {
      recorded = createOptions.mounts;
      return {
        worktreePath: SANDBOX_REPO_DIR,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      };
    },
  });
  return { provider, mounts: () => recorded };
};

/** What `resolveGitMounts` gives for a repo whose `.git` is a directory. */
const gitMountsFor = (gitDir: string) => [
  { hostPath: gitDir, sandboxPath: gitDir },
];

const readOnlyTargets = (mounts: readonly Mount[]) =>
  new Set(mounts.filter((m) => m.readonly === true).map((m) => m.sandboxPath));

describe("startSandbox git control files", () => {
  it("mounts a worktree's git control files read-only", async () => {
    const repo = makeRepo();
    const worktree = makeWorktree(repo);
    const { provider, mounts } = recordingProvider();

    await Effect.runPromise(
      startSandbox({
        provider,
        hostRepoDir: repo,
        env: {},
        worktreeOrRepoPath: worktree,
        gitMounts: gitMountsFor(join(repo, ".git")),
        repoDir: SANDBOX_REPO_DIR,
      }),
    );

    const gitDir = join(repo, ".git");
    expect(readOnlyTargets(mounts())).toStrictEqual(
      new Set([
        `${SANDBOX_REPO_DIR}/.git`,
        join(gitDir, "config"),
        join(gitDir, "hooks"),
        join(gitDir, "info"),
        join(gitDir, "worktrees", "w", "commondir"),
      ]),
    );
    // The rest of .git stays writable, so the agent can still commit.
    expect(mounts().find((m) => m.hostPath === gitDir)).toStrictEqual({
      hostPath: gitDir,
      sandboxPath: gitDir,
      readonly: undefined,
    });
  });

  it("covers the repo's .git at every path it is visible at in head mode", async () => {
    const repo = makeRepo();
    const { provider, mounts } = recordingProvider();

    await Effect.runPromise(
      startSandbox({
        provider,
        hostRepoDir: repo,
        env: {},
        worktreeOrRepoPath: repo,
        gitMounts: gitMountsFor(join(repo, ".git")),
        repoDir: SANDBOX_REPO_DIR,
      }),
    );

    expect(readOnlyTargets(mounts())).toStrictEqual(
      new Set([
        `${SANDBOX_REPO_DIR}/.git/config`,
        `${SANDBOX_REPO_DIR}/.git/hooks`,
        `${SANDBOX_REPO_DIR}/.git/info`,
        join(repo, ".git", "config"),
        join(repo, ".git", "hooks"),
        join(repo, ".git", "info"),
      ]),
    );
  });

  it("mounts the Windows .git override read-only", async () => {
    const repo = makeRepo();
    const worktree = makeWorktree(repo);
    const gitMounts = await Effect.runPromise(
      patchGitMountsForWindows(
        gitMountsFor(join(repo, ".git")),
        worktree,
        SANDBOX_REPO_DIR,
        async (p) => readFileSync(p, "utf8"),
        async () => "file",
        "win32",
      ),
    );
    const { provider, mounts } = recordingProvider();

    try {
      await Effect.runPromise(
        startSandbox({
          provider,
          hostRepoDir: repo,
          env: {},
          worktreeOrRepoPath: worktree,
          gitMounts,
          repoDir: SANDBOX_REPO_DIR,
        }),
      );
      expect(
        mounts().find((m) => m.sandboxPath === `${SANDBOX_REPO_DIR}/.git`),
      ).toStrictEqual(expect.objectContaining({ readonly: true }));
    } finally {
      await Effect.runPromise(removeMountTempDirs(gitMounts));
    }
  });
});
