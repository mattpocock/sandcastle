import { Effect } from "effect";
import { execSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostGit } from "./hostGit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A repo with one commit, a markers dir for payloads, and its own global config. */
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "host-git-"));
  roots.push(root);
  const repo = join(root, "repo");
  const markers = join(root, "markers");
  mkdirSync(repo);
  mkdirSync(markers);
  const globalConfig = join(root, "global.gitconfig");
  writeFileSync(globalConfig, "[user]\n\temail = t@t\n\tname = T\n");
  const env = { GIT_CONFIG_GLOBAL: globalConfig };
  const sh = (cmd: string, cwd = repo) => {
    execSync(cmd, { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
  };
  sh("git init -q -b main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  sh("git add a.txt && git commit -q -m init");
  const touch = (name: string) => `touch '${join(markers, name)}'`;
  const fired = () => new Set(readdirSync(markers));
  return { root, repo, env, globalConfig, sh, touch, fired };
};

type Ctx = ReturnType<typeof setup>;

const writeScript = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

const run = async (
  args: readonly string[],
  cwd: string,
  options: { env: Record<string, string>; input?: string },
) => Effect.runPromise(hostGit(args, cwd, options));

/** Plants every repository-config route to code execution the tests cover. */
const plant = ({ repo, root, sh, touch }: Ctx) => {
  sh(`git config core.fsmonitor "${touch("fsmonitor")}; false"`);
  writeScript(join(repo, ".git", "hooks", "pre-commit"), touch("hook"));
  // A clean filter reached only through an included file.
  const included = join(root, "included.gitconfig");
  writeFileSync(
    included,
    `[filter "evil"]\n\tclean = "${touch("filter")}; cat"\n`,
  );
  sh(`git config include.path "${included}"`);
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil\n");
  writeFileSync(join(repo, "a.txt"), "changed\n");
};

describe("hostGit", () => {
  it("plain git runs what the repository config names (sanity check)", () => {
    const ctx = setup();
    plant(ctx);
    ctx.sh("git add -A && git commit -q -m planted");
    expect(ctx.fired()).toStrictEqual(new Set(["filter", "fsmonitor", "hook"]));
  });

  it("runs none of it", async () => {
    const ctx = setup();
    plant(ctx);
    await run(["status", "--porcelain"], ctx.repo, ctx);
    await run(["add", "-A"], ctx.repo, ctx);
    await run(["commit", "-q", "-m", "planted"], ctx.repo, ctx);
    expect(ctx.fired()).toStrictEqual(new Set());
  });

  it("keeps the user's own hooks path and credential helpers, but not the repository's", async () => {
    const ctx = setup();
    const globalHooks = join(ctx.root, "global-hooks");
    mkdirSync(globalHooks);
    writeScript(join(globalHooks, "pre-commit"), ctx.touch("global-hook"));
    writeFileSync(
      ctx.globalConfig,
      [
        "[user]\n\temail = t@t\n\tname = T",
        `[core]\n\thooksPath = ${globalHooks}`,
        `[credential]\n\thelper = "!${ctx.touch("global-helper")}; true"`,
        "",
      ].join("\n"),
    );
    ctx.sh(`git config core.hooksPath "${join(ctx.repo, "evil")}"`);
    ctx.sh(`git config credential.helper "!${ctx.touch("repo-helper")}; true"`);
    ctx.sh(
      `git config credential.https://example.com.helper "!${ctx.touch("repo-url-helper")}; true"`,
    );

    await run(["commit", "-q", "--allow-empty", "-m", "x"], ctx.repo, ctx);
    await run(["credential", "fill"], ctx.repo, {
      env: ctx.env,
      input: "protocol=https\nhost=example.com\n\n",
    }).catch(() => "no credential");

    expect(ctx.fired()).toStrictEqual(
      new Set(["global-helper", "global-hook"]),
    );
  });

  it("survives git exiting without reading its input", async () => {
    const ctx = setup();
    await expect(
      run(["rev-parse", "--is-inside-work-tree"], ctx.repo, {
        env: ctx.env,
        input: "x".repeat(8 * 1024 * 1024),
      }),
    ).resolves.toBe("true\n");
  });

  describe("worktrees under .sandcastle/worktrees", () => {
    const setupWorktree = () => {
      const ctx = setup();
      const worktree = join(ctx.repo, ".sandcastle", "worktrees", "w");
      ctx.sh(`git worktree add -q -b w "${worktree}"`);
      return { ...ctx, worktree };
    };

    /** A fake repo whose config runs a payload on `git status`. */
    const fakeGitDir = (ctx: Ctx) => {
      const fake = join(ctx.root, "fake");
      mkdirSync(fake);
      ctx.sh("git init -q", fake);
      ctx.sh(
        `git config core.fsmonitor "${ctx.touch("redirect")}; false"`,
        fake,
      );
      return join(fake, ".git");
    };

    it("runs git in a valid worktree", async () => {
      const ctx = setupWorktree();
      writeFileSync(join(ctx.worktree, "new.txt"), "x");
      await expect(
        run(["status", "--porcelain"], ctx.worktree, ctx),
      ).resolves.toBe("?? new.txt\n");
    });

    it("refuses a worktree whose .git points at another git dir", async () => {
      const ctx = setupWorktree();
      writeFileSync(join(ctx.worktree, ".git"), `gitdir: ${fakeGitDir(ctx)}\n`);

      await expect(
        run(["status", "--porcelain"], ctx.worktree, ctx),
      ).rejects.toThrow(/Refusing to run git on the host/u);
      expect(ctx.fired()).toStrictEqual(new Set());
    });

    it("refuses a worktree whose commondir points at another repo", async () => {
      const ctx = setupWorktree();
      // A copy of git's layout inside the fake repo, so only the anchor to
      // the real repo can tell it apart.
      const fakeAdmin = join(fakeGitDir(ctx), "worktrees", "w");
      mkdirSync(fakeAdmin, { recursive: true });
      writeFileSync(join(fakeAdmin, "commondir"), "../..\n");
      writeFileSync(join(fakeAdmin, "HEAD"), "ref: refs/heads/w\n");
      writeFileSync(join(ctx.worktree, ".git"), `gitdir: ${fakeAdmin}\n`);

      await expect(
        run(["status", "--porcelain"], ctx.worktree, ctx),
      ).rejects.toThrow(/not to/u);
      expect(ctx.fired()).toStrictEqual(new Set());
    });

    it("refuses a worktree whose .git file was replaced by a directory", async () => {
      const ctx = setupWorktree();
      rmSync(join(ctx.worktree, ".git"));
      ctx.sh("git init -q", ctx.worktree);
      ctx.sh(
        `git config core.fsmonitor "${ctx.touch("dir")}; false"`,
        ctx.worktree,
      );

      await expect(
        run(["status", "--porcelain"], ctx.worktree, ctx),
      ).rejects.toThrow(/Refusing to run git on the host/u);
      expect(ctx.fired()).toStrictEqual(new Set());
    });
  });

  describe("programs and transports", () => {
    const withPath = (ctx: Ctx, ...dirs: string[]) => ({
      ...ctx.env,
      PATH: [...dirs, process.env["PATH"] ?? ""].join(delimiter),
    });

    it("never runs a git planted on a relative PATH entry", async () => {
      const ctx = setup();
      mkdirSync(join(ctx.repo, "bin"));
      writeScript(join(ctx.repo, "bin", "git"), `${ctx.touch("git")}; exit 1`);

      await expect(
        run(["rev-parse", "HEAD"], ctx.repo, { env: withPath(ctx, "bin") }),
      ).resolves.toMatch(/^[0-9a-f]{40}\n$/u);
      expect(ctx.fired()).toStrictEqual(new Set());
    });

    it("never runs an ssh planted on a PATH entry inside the repo", async () => {
      const ctx = setup();
      const bin = join(ctx.repo, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeScript(join(bin, "ssh"), `${ctx.touch("ssh")}; exit 1`);
      ctx.sh("git remote add origin ssh://git@127.0.0.1:1/x.git");

      await run(["fetch", "origin", "main"], ctx.repo, {
        env: withPath(ctx, bin),
      }).catch(() => "fetch failed");
      expect(ctx.fired()).toStrictEqual(new Set());
    });

    it("refuses a remote URL that names a remote helper", async () => {
      const ctx = setup();
      // A helper the host could find, outside the repo.
      const bin = join(ctx.root, "bin");
      mkdirSync(bin);
      writeScript(
        join(bin, "git-remote-evil"),
        `${ctx.touch("helper")}; exit 1`,
      );
      ctx.sh("git remote add origin evil::payload");

      await expect(
        run(["fetch", "origin", "main"], ctx.repo, { env: withPath(ctx, bin) }),
      ).rejects.toThrow(/not allowed/u);
      expect(ctx.fired()).toStrictEqual(new Set());
    });

    it("still fetches from a local remote, and allows https and ssh", async () => {
      const ctx = setup();
      const remote = join(ctx.root, "remote.git");
      ctx.sh(`git clone -q --bare "${ctx.repo}" "${remote}"`, ctx.root);
      ctx.sh(`git remote add origin "${remote}"`);

      await expect(
        run(["fetch", "origin", "main"], ctx.repo, ctx),
      ).resolves.toBeDefined();
      const messages = await Promise.all(
        ["https://127.0.0.1:1/x.git", "ssh://git@127.0.0.1:1/x.git"].map(
          async (url) =>
            run(["ls-remote", url], ctx.repo, ctx).then(() => "", String),
        ),
      );
      expect(messages.join("\n")).not.toMatch(/not allowed/u);
    });
  });
});
