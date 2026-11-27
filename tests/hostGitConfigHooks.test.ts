import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// Config-defined hooks (git 2.54+: `hook.<name>.command` run on each
// `hook.<name>.event`) never run from repository config during Sandcastle's
// host git, wherever the repository defines them: its config, an included
// file, a conditional include, or worktree config. The user's own hooks from
// global config still run. Each "plain git" case shows the planted hook does
// run when git is used directly, so the guarded cases are meaningful. Hooks
// in config need git 2.54, so on an older git every case is skipped.

const isWindows = process.platform === "win32";

const gitVersion = (): readonly number[] =>
  (
    /(?<version>\d+\.\d+)/u.exec(
      execFileSync("git", ["--version"], { encoding: "utf8" }),
    )?.groups?.["version"] ?? "0.0"
  )
    .split(".")
    .map(Number);

const [major = 0, minor = 0] = gitVersion();
const hasConfigHooks = major > 2 || (major === 2 && minor >= 54);

/** Every hook event Sandcastle's host git could fire. */
const EVENTS = [
  "post-checkout",
  "post-merge",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "pre-commit",
  "post-commit",
  "reference-transaction",
  "post-index-change",
  "post-rewrite",
];

/** The tags of the planted hooks, one per way of planting them. */
const TAGS = ["local", "include", "includeIf", "wtcfg", "linked", "child"];

/** The name of the hook planted with `tag` for `event`. */
const hookName = (tag: string, event: string): string => `${tag}-${event}`;

/** Git config for the sandbox's own git: none of the planted hooks. */
const SANDBOX_GIT_ENV = (() => {
  const names = TAGS.flatMap((tag) => EVENTS.map((e) => hookName(tag, e)));
  return {
    GIT_CONFIG_COUNT: String(names.length),
    ...Object.fromEntries(
      names.flatMap((name, i) => [
        [`GIT_CONFIG_KEY_${i}`, `hook.${name}.enabled`],
        [`GIT_CONFIG_VALUE_${i}`, "false"],
      ]),
    ),
  };
})();

const worktreeDir = (repo: string, branch: string): string =>
  path.join(repo, ".sandcastle", "worktrees", branch.replaceAll("/", "-"));

describe.skipIf(isWindows || !hasConfigHooks)(
  "config-defined hooks in host git",
  () => {
    let root = "";
    let repo = "";
    let markers = "";
    let globalConfig = "";

    const git = (cwd: string, ...args: string[]): string =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

    const touch = (name: string): string =>
      `touch '${path.join(markers, name)}'`;

    const fired = (): Set<string> => new Set(readdirSync(markers));

    /** Config text defining a hook named `tag` for every event. */
    const hooks = (tag: string): string =>
      EVENTS.map(
        (event) =>
          `[hook "${hookName(tag, event)}"]\n\tcommand = ${touch(tag)}\n\tevent = ${event}\n`,
      ).join("");

    const gitDir = (): string => path.join(repo, ".git");

    const appendTo = (file: string, text: string): void => {
      writeFileSync(file, text, { flag: "a" });
    };

    const enableWorktreeConfig = (): void => {
      git(repo, "config", "extensions.worktreeConfig", "true");
    };

    beforeEach(() => {
      root = realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-cfg-hooks-")));
      repo = path.join(root, "repo");
      markers = path.join(root, "markers");
      mkdirSync(repo);
      mkdirSync(markers);
      globalConfig = path.join(root, "global.gitconfig");
      writeFileSync(globalConfig, "[user]\n\temail = t@t\n\tname = T\n");
      vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(path.join(repo, "a.txt"), "a\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    });

    /** A sandbox whose agent commits a change to a.txt, then finishes. */
    const committingSandbox = () =>
      createBindMountSandboxProvider({
        name: "committing",
        create: async (options): Promise<BindMountSandboxHandle> => {
          const hostWorktree = options.mounts[0]?.hostPath ?? "";
          return {
            worktreePath: options.worktreePath,
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
              writeFileSync(path.join(hostWorktree, "a.txt"), "agent\n");
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

    const mergeAgentWorkToHead = async () =>
      run({
        agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
        sandbox: committingSandbox(),
        cwd: repo,
        prompt: "Change a.txt.",
        branchStrategy: { type: "merge-to-head" },
        logging: { type: "file", path: path.join(root, "run.log") },
      });

    /** Plain git: commit on a branch, merge it into main, add a worktree. */
    const plainMergeAndWorktree = (): void => {
      git(repo, "branch", "plain");
      git(repo, "worktree", "add", "-q", path.join(root, "p"), "plain");
      git(path.join(root, "p"), "commit", "-q", "--allow-empty", "-m", "p");
      git(repo, "merge", "-q", "--no-ff", "--no-edit", "plain");
    };

    /** The ways repository config in the main worktree can define a hook. */
    const mainWorktreeVectors: Record<string, () => void> = {
      ".git/config": () => {
        appendTo(path.join(gitDir(), "config"), hooks("local"));
      },
      "an included file": () => {
        writeFileSync(path.join(gitDir(), "evil.cfg"), hooks("include"));
        git(repo, "config", "include.path", "evil.cfg");
      },
      "a conditional include": () => {
        writeFileSync(path.join(gitDir(), "evil.cfg"), hooks("includeIf"));
        git(repo, "config", "includeIf.onbranch:main.path", "evil.cfg");
      },
      ".git/config.worktree": () => {
        enableWorktreeConfig();
        writeFileSync(path.join(gitDir(), "config.worktree"), hooks("wtcfg"));
      },
    };

    describe.each(Object.entries(mainWorktreeVectors))(
      "a hook defined in %s",
      (_name, plant) => {
        it("plain git runs it", () => {
          plant();
          plainMergeAndWorktree();
          expect(fired().size).toBe(1);
        });

        it("runs nowhere while merging an agent's commit back to HEAD", async () => {
          plant();
          const result = await mergeAgentWorkToHead();
          expect({
            commits: result.commits.length,
            head: git(repo, "log", "-1", "--format=%s").trim(),
            fired: fired(),
          }).toStrictEqual({
            commits: 1,
            head: "agent work",
            fired: new Set(),
          });
        });
      },
    );

    describe("a hook in a linked worktree's config.worktree", () => {
      /**
       * A managed worktree for "w" behind origin, so reusing it fetches and
       * fast-forwards there, with hooks planted in its own worktree config.
       */
      const plantInManagedWorktree = (): string => {
        const worktree = worktreeDir(repo, "w");
        git(repo, "worktree", "add", "-q", "-b", "w", worktree);
        const remote = path.join(root, "remote.git");
        git(root, "clone", "-q", "--bare", repo, remote);
        git(repo, "remote", "add", "origin", remote);
        const ahead = path.join(root, "ahead");
        git(root, "clone", "-q", remote, ahead);
        git(ahead, "checkout", "-q", "-b", "w");
        git(ahead, "commit", "-q", "--allow-empty", "-m", "ahead");
        git(ahead, "push", "-q", "origin", "w");
        enableWorktreeConfig();
        writeFileSync(
          path.join(gitDir(), "worktrees", "w", "config.worktree"),
          hooks("linked"),
        );
        return worktree;
      };

      it("plain git runs it", () => {
        const worktree = plantInManagedWorktree();
        git(worktree, "fetch", "-q", "origin", "w");
        git(worktree, "merge", "-q", "--ff-only", "origin/w");
        expect(fired()).toStrictEqual(new Set(["linked"]));
      });

      it("runs nowhere while reusing the worktree", async () => {
        plantInManagedWorktree();
        const worktree = await createWorktree({
          branchStrategy: { type: "branch", branch: "w" },
          cwd: repo,
        });
        const subject = git(worktree.worktreePath, "log", "-1", "--format=%s");
        await worktree.close();
        expect({ subject: subject.trim(), fired: fired() }).toStrictEqual({
          subject: "ahead",
          fired: new Set(),
        });
      });
    });

    describe("a hook included only for a new worktree", () => {
      // `git worktree add` checks the new worktree out with a child git, which
      // evaluates conditional includes for that worktree, not the repo.
      const plant = (): void => {
        writeFileSync(path.join(root, "evil.cfg"), hooks("child"));
        git(
          repo,
          "config",
          `includeIf.gitdir:${gitDir()}/worktrees/**.path`,
          path.join(root, "evil.cfg"),
        );
      };

      it("plain git runs it", () => {
        plant();
        git(repo, "worktree", "add", "-q", "-b", "plain", path.join(root, "p"));
        expect(fired()).toStrictEqual(new Set(["child"]));
      });

      it("runs nowhere while creating a worktree", async () => {
        plant();
        const worktree = await createWorktree({
          branchStrategy: { type: "branch", branch: "w" },
          cwd: repo,
        });
        await worktree.close();
        expect(fired()).toStrictEqual(new Set());
      });
    });

    describe("the user's own hooks", () => {
      const globalHook = (): void => {
        appendTo(
          globalConfig,
          `[hook "mine"]\n\tcommand = ${touch("global")}\n\tevent = post-checkout\n`,
        );
      };

      it("still run from global config", async () => {
        globalHook();
        const worktree = await createWorktree({
          branchStrategy: { type: "branch", branch: "w" },
          cwd: repo,
        });
        await worktree.close();
        expect(fired()).toStrictEqual(new Set(["global"]));
      });

      it("keep their own command when the repository redefines it", async () => {
        globalHook();
        git(repo, "config", "hook.mine.command", touch("swapped"));
        const worktree = await createWorktree({
          branchStrategy: { type: "branch", branch: "w" },
          cwd: repo,
        });
        await worktree.close();
        expect(fired()).toStrictEqual(new Set(["global"]));
      });
    });
  },
);
