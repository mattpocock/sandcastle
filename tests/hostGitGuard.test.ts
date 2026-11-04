import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BindMountSandboxHandle } from "@ai-hero/sandcastle";
import {
  claudeCode,
  createBindMountSandboxProvider,
  createWorktree,
  run,
} from "@ai-hero/sandcastle";

// Host git guard behaviour: the git Sandcastle runs on the host for a repo
// (worktree setup and reuse, status checks, origin refresh, merging back)
// never runs a program the repository itself names, and refuses a managed
// worktree that no longer belongs to its repo. The user's own global config
// still applies. Each "plain git" case shows the planted program does run
// when git is used directly, so the guarded cases are meaningful.

const isWindows = process.platform === "win32";

/** The directory name Sandcastle gives a branch's managed worktree. */
const worktreeDir = (repo: string, branch: string): string =>
  path.join(repo, ".sandcastle", "worktrees", branch.replaceAll("/", "-"));

/** Git config for the sandbox's own git: none of the planted programs. */
const SANDBOX_GIT_ENV = {
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "filter.evil.clean",
  GIT_CONFIG_VALUE_2: "cat",
  GIT_CONFIG_KEY_3: "filter.evil.smudge",
  GIT_CONFIG_VALUE_3: "cat",
};

const writeScript = (file: string, body: string): void => {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

describe.skipIf(isWindows)("host git guard behaviour", () => {
  let root = "";
  let repo = "";
  let markers = "";
  let globalConfig = "";

  /** Plain git, as a user would run it, with the test's global config. */
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

  /** Plain git that is expected to fail (an unreachable remote). */
  const gitMayFail = (cwd: string, ...args: string[]): void => {
    spawnSync("git", args, { cwd, stdio: "ignore" });
  };

  /** A shell command that records that `name` ran. */
  const touch = (name: string): string => `touch '${path.join(markers, name)}'`;

  /** The names of every planted program that ran. */
  const fired = (): Set<string> => new Set(readdirSync(markers));

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-host-git-")));
    repo = path.join(root, "repo");
    markers = path.join(root, "markers");
    mkdirSync(repo);
    mkdirSync(markers);
    globalConfig = path.join(root, "global.gitconfig");
    writeFileSync(globalConfig, "[user]\n\temail = t@t\n\tname = T\n");
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    git(repo, "init", "-q", "-b", "main");
    // Committed before any filter is configured, so it is inert until then.
    writeFileSync(path.join(repo, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  /** Plants every repository-config route to running a program. */
  const plant = (): void => {
    git(repo, "config", "core.fsmonitor", `${touch("fsmonitor")}; false`);
    for (const hook of [
      "pre-commit",
      "post-checkout",
      "post-merge",
      "pre-merge-commit",
      "reference-transaction",
    ]) {
      writeScript(path.join(repo, ".git", "hooks", hook), touch("hook"));
    }
    // A filter reached only through an included file.
    const included = path.join(root, "included.gitconfig");
    writeFileSync(
      included,
      [
        `[filter "evil"]`,
        `\tclean = "${touch("filter")}; cat"`,
        `\tsmudge = "${touch("filter")}; cat"`,
        "",
      ].join("\n"),
    );
    git(repo, "config", "include.path", included);
  };

  /** A sandbox whose agent commits `file` in its worktree, then finishes. */
  const committingSandbox = (file: string) =>
    createBindMountSandboxProvider({
      name: "committing",
      create: async (options): Promise<BindMountSandboxHandle> => {
        const hostWorktree = options.mounts[0]?.hostPath ?? "";
        return {
          worktreePath: options.worktreePath,
          // Everything the sandbox runs, the agent included, runs in the
          // worktree with git opted out of the planted programs: that is the
          // sandbox's own business. Only the host's git is under test.
          exec: async (command, execOptions) => {
            const inSandbox = (script: string): string =>
              execFileSync("sh", ["-c", script], {
                cwd: hostWorktree,
                encoding: "utf8",
                env: { ...process.env, ...SANDBOX_GIT_ENV },
              });
            if (!command.startsWith("claude ")) {
              return { stdout: inSandbox(command), stderr: "", exitCode: 0 };
            }
            writeFileSync(path.join(hostWorktree, file), "agent\n");
            inSandbox("git commit -q -a -m 'agent work'");
            const done = JSON.stringify({
              type: "result",
              subtype: "success",
              result: "<promise>COMPLETE</promise>",
            });
            execOptions?.onLine?.(done);
            return { stdout: done, stderr: "", exitCode: 0 };
          },
          copyFileIn: async () => undefined,
          copyFileOut: async () => undefined,
          close: async () => undefined,
        };
      },
    });

  describe("repository config, hooks and filters", () => {
    it("plain git runs what the repository config names", () => {
      plant();
      git(repo, "worktree", "add", "-q", "-b", "plain", path.join(root, "w"));
      writeFileSync(path.join(repo, "a.txt"), "changed\n");
      git(repo, "status", "--porcelain");
      expect(fired()).toStrictEqual(new Set(["filter", "fsmonitor", "hook"]));
    });

    it("runs none of it while creating, reusing and closing a worktree", async () => {
      plant();
      const first = await createWorktree({
        branchStrategy: { type: "branch", branch: "w" },
        cwd: repo,
      });
      const reused = await createWorktree({
        branchStrategy: { type: "branch", branch: "w" },
        cwd: repo,
      });
      writeFileSync(path.join(reused.worktreePath, "a.txt"), "changed\n");
      await reused.close();
      await first.close();
      expect(fired()).toStrictEqual(new Set());
    });

    it("runs none of it while merging an agent's commit back to HEAD", async () => {
      plant();
      const result = await run({
        agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
        sandbox: committingSandbox("a.txt"),
        cwd: repo,
        prompt: "Change a.txt.",
        branchStrategy: { type: "merge-to-head" },
        logging: { type: "file", path: path.join(root, "run.log") },
      });
      expect({
        commits: result.commits.length,
        head: git(repo, "log", "-1", "--format=%s").trim(),
        fired: fired(),
      }).toStrictEqual({ commits: 1, head: "agent work", fired: new Set() });
    });

    it("keeps the user's own hooks path, but not the repository's", async () => {
      const globalHooks = path.join(root, "global-hooks");
      mkdirSync(globalHooks);
      writeScript(
        path.join(globalHooks, "post-checkout"),
        touch("global-hook"),
      );
      writeFileSync(
        globalConfig,
        `[user]\n\temail = t@t\n\tname = T\n[core]\n\thooksPath = ${globalHooks}\n`,
      );
      const repoHooks = path.join(repo, "evil-hooks");
      mkdirSync(repoHooks);
      writeScript(path.join(repoHooks, "post-checkout"), touch("repo-hook"));
      git(repo, "config", "core.hooksPath", repoHooks);

      const worktree = await createWorktree({
        branchStrategy: { type: "branch", branch: "w" },
        cwd: repo,
      });
      await worktree.close();
      expect(fired()).toStrictEqual(new Set(["global-hook"]));
    });
  });

  describe("managed worktrees that no longer belong to their repo", () => {
    /** A managed worktree for branch "w", made by plain git. */
    const managedWorktree = (): string => {
      const worktree = worktreeDir(repo, "w");
      git(repo, "worktree", "add", "-q", "-b", "w", worktree);
      return worktree;
    };

    /** Another repo whose config runs a payload on `git status`. */
    const fakeGitDir = (): string => {
      const fake = path.join(root, "fake");
      mkdirSync(fake);
      git(fake, "init", "-q");
      git(fake, "config", "core.fsmonitor", `${touch("redirect")}; false`);
      return path.join(fake, ".git");
    };

    const reuse = async () =>
      createWorktree({
        branchStrategy: { type: "branch", branch: "w" },
        cwd: repo,
      });

    it("reuses a worktree that still belongs to the repo", async () => {
      managedWorktree();
      const worktree = await reuse();
      await worktree.close();
      expect(worktree.worktreePath).toBe(worktreeDir(repo, "w"));
    });

    it("refuses a worktree whose .git points at another git dir", async () => {
      const worktree = managedWorktree();
      writeFileSync(path.join(worktree, ".git"), `gitdir: ${fakeGitDir()}\n`);

      await expect(reuse()).rejects.toThrow(/Refusing to run git on the host/u);
      expect(fired()).toStrictEqual(new Set());
    });

    it("refuses a worktree whose commondir points at another repo", async () => {
      const worktree = managedWorktree();
      // A copy of git's layout inside the fake repo, so only the anchor to
      // the real repo can tell it apart.
      const fakeAdmin = path.join(fakeGitDir(), "worktrees", "w");
      mkdirSync(fakeAdmin, { recursive: true });
      writeFileSync(path.join(fakeAdmin, "commondir"), "../..\n");
      writeFileSync(path.join(fakeAdmin, "HEAD"), "ref: refs/heads/w\n");
      writeFileSync(path.join(worktree, ".git"), `gitdir: ${fakeAdmin}\n`);

      await expect(reuse()).rejects.toThrow(/not to/u);
      expect(fired()).toStrictEqual(new Set());
    });

    it("refuses a worktree whose .git file was replaced by a directory", async () => {
      const worktree = managedWorktree();
      rmSync(path.join(worktree, ".git"));
      git(worktree, "init", "-q");
      git(worktree, "config", "core.fsmonitor", `${touch("dir")}; false`);

      await expect(reuse()).rejects.toThrow(/Refusing to run git on the host/u);
      expect(fired()).toStrictEqual(new Set());
    });
  });

  describe("programs and transports", () => {
    /** Puts `dirs` first on the PATH Sandcastle's host git inherits. */
    const prependPath = (...dirs: string[]): void => {
      vi.stubEnv(
        "PATH",
        [...dirs, process.env["PATH"] ?? ""].join(path.delimiter),
      );
    };

    /**
     * A managed worktree for "w" with `url` as origin, so reusing it
     * refreshes from origin on the host.
     */
    const withOrigin = (url: string): void => {
      git(repo, "worktree", "add", "-q", "-b", "w", worktreeDir(repo, "w"));
      git(repo, "remote", "add", "origin", url);
    };

    const reuse = async () => {
      const worktree = await createWorktree({
        branchStrategy: { type: "branch", branch: "w" },
        cwd: repo,
      });
      await worktree.close();
    };

    let server: Server | undefined;
    afterEach(async () => {
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve) => {
        if (closing === undefined) {
          resolve();
          return;
        }
        closing.close(() => {
          resolve();
        });
      });
    });

    /** An HTTP server that asks for credentials and counts requests. */
    const authServer = async (): Promise<{
      url: string;
      requests: () => number;
    }> => {
      let count = 0;
      const listening = createServer((_req, res) => {
        count++;
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' });
        res.end();
      });
      server = listening;
      await new Promise<void>((resolve) => {
        listening.listen(0, "127.0.0.1", resolve);
      });
      const address = listening.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      return { url: `http://127.0.0.1:${port}/x.git`, requests: () => count };
    };

    it("never runs a git planted on a relative PATH entry", async () => {
      mkdirSync(path.join(repo, "bin"));
      writeScript(path.join(repo, "bin", "git"), `${touch("git")}; exit 1`);
      prependPath("bin");

      const worktree = await createWorktree({
        branchStrategy: { type: "branch", branch: "w" },
        cwd: repo,
      });
      await worktree.close();
      expect(fired()).toStrictEqual(new Set());
    });

    it("plain git runs an ssh planted on a PATH entry inside the repo", () => {
      const bin = path.join(repo, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeScript(path.join(bin, "ssh"), `${touch("ssh")}; exit 1`);
      withOrigin("ssh://git@127.0.0.1:1/x.git");
      prependPath(bin);

      gitMayFail(repo, "fetch", "origin", "w");
      expect(fired()).toStrictEqual(new Set(["ssh"]));
    });

    it("never runs an ssh planted on a PATH entry inside the repo", async () => {
      const bin = path.join(repo, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeScript(path.join(bin, "ssh"), `${touch("ssh")}; exit 1`);
      withOrigin("ssh://git@127.0.0.1:1/x.git");
      prependPath(bin);

      await reuse();
      expect(fired()).toStrictEqual(new Set());
    });

    it("still uses the user's own ssh for an ssh remote", async () => {
      const userSsh = path.join(root, "user-ssh");
      writeScript(userSsh, `${touch("user-ssh")}; exit 1`);
      vi.stubEnv("GIT_SSH_COMMAND", userSsh);
      withOrigin("ssh://git@127.0.0.1:1/x.git");

      await reuse();
      expect(fired()).toStrictEqual(new Set(["user-ssh"]));
    });

    it("plain git runs a remote helper a remote URL names", () => {
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      writeScript(
        path.join(bin, "git-remote-evil"),
        `${touch("helper")}; exit 1`,
      );
      withOrigin("evil::payload");
      prependPath(bin);

      gitMayFail(repo, "fetch", "origin", "w");
      expect(fired()).toStrictEqual(new Set(["helper"]));
    });

    it("never runs a remote helper a remote URL names", async () => {
      // A helper the host could find, outside the repo.
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      writeScript(
        path.join(bin, "git-remote-evil"),
        `${touch("helper")}; exit 1`,
      );
      withOrigin("evil::payload");
      prependPath(bin);

      await reuse();
      expect(fired()).toStrictEqual(new Set());
    });

    it("still fetches from an http remote, with the user's credential helper but not the repository's", async () => {
      const { url, requests } = await authServer();
      writeFileSync(
        globalConfig,
        `[user]\n\temail = t@t\n\tname = T\n[credential]\n\thelper = "!${touch("global-helper")}; true"\n`,
      );
      withOrigin(url);
      git(
        repo,
        "config",
        "credential.helper",
        `!${touch("repo-helper")}; true`,
      );
      git(
        repo,
        "config",
        `credential.${url}.helper`,
        `!${touch("repo-url-helper")}; true`,
      );

      await reuse();
      expect({ asked: requests() > 0, fired: fired() }).toStrictEqual({
        asked: true,
        fired: new Set(["global-helper"]),
      });
    });

    it("still fetches from a local remote and fast-forwards the worktree", async () => {
      const remote = path.join(root, "remote.git");
      git(root, "clone", "-q", "--bare", repo, remote);
      withOrigin(remote);
      // origin's w moves ahead of the worktree's.
      const ahead = path.join(root, "ahead");
      git(root, "clone", "-q", remote, ahead);
      git(ahead, "checkout", "-q", "-b", "w");
      git(ahead, "commit", "-q", "--allow-empty", "-m", "ahead");
      git(ahead, "push", "-q", "origin", "w");

      const worktree = await createWorktree({
        branchStrategy: { type: "branch", branch: "w" },
        cwd: repo,
      });
      const subject = git(worktree.worktreePath, "log", "-1", "--format=%s");
      await worktree.close();
      expect(subject.trim()).toBe("ahead");
    });
  });
});
