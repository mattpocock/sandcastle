import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { createSandbox } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type { ImplementInput } from "@ai-hero/sandcastle/v1/tasks";
import { implement } from "@ai-hero/sandcastle/v1/tasks";
import { bareRepo, stubClaude } from "./helpers/taskWorld.js";

// `implement` with a `base` branch: a new branch from the base's tip on
// `origin`, and a PR against the base. On the fake sandbox with a local bare
// repo standing in for GitHub and a stub `claude`. POSIX only, like the other
// task tests.

const TOKEN = "ghs_implementbasetesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const REPORTED = `Opened the PR.\n<implementResult>${JSON.stringify({
  status: "pr-opened",
  branch: "b",
  pr: { number: 7, url: "https://github.com/o/widgets/pull/7" },
  summary: "Added the widget.",
})}</implementResult>`;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

describe.skipIf(process.platform === "win32")(
  "the implement task's base branch (v1)",
  () => {
    let rootDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let origin = "";

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-base-"));
      provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
      origin = await bareRepo(rootDir);
    });

    afterEach(async () => {
      await provider.closeAll();
      await rm(rootDir, { recursive: true, force: true });
    });

    const clone = (sandbox: Sandbox): string =>
      path.join(provider.pathOf(sandbox.sandboxId), "work", "widgets");

    /** Pushes a `feature` branch one commit ahead of `main`; resolves with its tip. */
    const pushFeature = async (): Promise<string> => {
      const seed = path.join(rootDir, "seed");
      git(seed, "switch", "--quiet", "--create", "feature");
      await writeFile(path.join(seed, "feature.ts"), "export const f = 1;\n");
      git(seed, "add", ".");
      git(
        seed,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "--quiet",
        "-m",
        "feature",
      );
      git(seed, "push", "--quiet", origin, "HEAD");
      return git(seed, "rev-parse", "HEAD");
    };

    const run = async (input: ImplementInput) => {
      const claude = await stubClaude(path.join(rootDir, "agent"), [
        init("s-base"),
        result(REPORTED),
      ]);
      const sandbox = await createSandbox({
        provider,
        env: claude.env,
        timeLimitMinutes: implement.limits.timeLimitMinutes,
      });
      const spawned = await implement.start(sandbox, input);
      await spawned.wait();
      const prompt = await claude.read("agent-prompt.txt");
      return { sandbox, claude, prompt };
    };

    const common = () =>
      ({ repo: origin, githubToken: TOKEN, skillsContext: GITHUB }) as const;

    it("creates its new branch from the base's tip, not tracking the base", async () => {
      const tip = await pushFeature();

      const { sandbox } = await run({
        ...common(),
        ticket: "42",
        base: "feature",
      });

      const branch = git(clone(sandbox), "branch", "--show-current");
      expect(branch).toMatch(/^sandcastle\/implement-42-/u);
      expect(git(clone(sandbox), "rev-parse", "HEAD")).toBe(tip);
      expect(git(clone(sandbox), "rev-parse", "HEAD")).not.toBe(
        git(origin, "rev-parse", "main"),
      );
      expect(
        git(
          clone(sandbox),
          "config",
          "--default",
          "",
          `branch.${branch}.merge`,
        ),
      ).toBe("");
    });

    it("tells the agent the branch is from the base, and to open the PR against it", async () => {
      await pushFeature();

      const { prompt } = await run({
        ...common(),
        ticket: "42",
        base: "feature",
      });

      expect(prompt).toContain("a new branch from `feature`");
      expect(prompt).toContain("open one against `feature`");
      expect(prompt).toContain("gh pr create --base feature");
      expect(prompt).not.toContain("default branch");
    });

    it("rejects a base the remote doesn't have before the session starts", async () => {
      const claude = await stubClaude(path.join(rootDir, "agent"), [
        init("s-missing"),
        result(REPORTED),
      ]);
      await using sandbox = await createSandbox({
        provider,
        env: claude.env,
        timeLimitMinutes: implement.limits.timeLimitMinutes,
      });

      await expect(
        implement.start(sandbox, {
          ...common(),
          ticket: "42",
          base: "no-such-base",
        }),
      ).rejects.toThrow(/no-such-base/u);
      await expect(claude.read("agent-prompt.txt")).rejects.toThrow(/ENOENT/u);
    });

    it("refuses a base that reads as an option", async () => {
      await expect(
        run({ ...common(), ticket: "42", base: "--upload-pack=x" }),
      ).rejects.toThrow(/isn't a branch name/u);
    });

    it("names the default branch, as before, without a base", async () => {
      const { sandbox, prompt } = await run({ ...common(), ticket: "42" });

      expect(git(clone(sandbox), "rev-parse", "HEAD")).toBe(
        git(origin, "rev-parse", "main"),
      );
      expect(prompt).toContain(
        "a new branch from the repository's default branch",
      );
      expect(prompt).toContain("open one against the default branch");
    });

    it("takes a base only for a new branch", () => {
      // @ts-expect-error: an existing branch's PR already has its base.
      const round2: ImplementInput = {
        ...common(),
        ticket: "42",
        branch: "sandcastle/implement-42-round1",
        base: "feature",
      };
      expect(round2.branch).toBe("sandcastle/implement-42-round1");
    });
  },
);
