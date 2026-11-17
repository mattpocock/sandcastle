import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { createSandbox } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import {
  general,
  implement,
  implementSpec,
  merge,
  review,
} from "@ai-hero/sandcastle/v1/tasks";
import { git, graphChooser } from "./helpers/specWorld.js";
import { bareRepo, pathWithout, stubClaude } from "./helpers/taskWorld.js";

// The bundled tasks that read or open pull requests need the GitHub CLI in
// the sandbox, and not every image has it. On the fake sandbox with no `gh`
// on its PATH, they reject before they clone, push or spawn anything. POSIX
// only, like the other task tests.

const TOKEN = "ghs_ghpreflighttesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const OK = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  JSON.stringify({ type: "result", is_error: false, result: "ok" }),
];

describe.skipIf(process.platform === "win32")(
  "the bundled tasks' gh preflight (v1)",
  { timeout: 30_000 },
  () => {
    let rootDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let origin = "";

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-gh-"));
      provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
      origin = await bareRepo(rootDir);
      git(origin, "branch", "integration", "main");
    });

    afterEach(async () => {
      await provider.closeAll();
      await rm(rootDir, { recursive: true, force: true });
    });

    /** A sandbox with a stub `claude`, and no `gh`, on its PATH. */
    const withoutGh = async (): Promise<Sandbox> => {
      const agentDir = path.join(rootDir, "agent");
      const claude = await stubClaude(agentDir, OK);
      await rm(path.join(agentDir, "bin", "gh"));
      return createSandbox({
        provider,
        env: { PATH: await pathWithout(rootDir, "gh", claude.env.PATH) },
        timeLimitMinutes: implementSpec.limits.timeLimitMinutes,
      });
    };

    const work = async (sandbox: Sandbox): Promise<string[]> =>
      readdir(path.join(provider.pathOf(sandbox.sandboxId), "work"));

    it("implementSpec rejects before it pushes its integration branch", async () => {
      const sandbox = await withoutGh();

      await expect(
        implementSpec.start(sandbox, {
          repo: origin,
          spec: "7",
          githubToken: TOKEN,
          skillsContext: GITHUB,
          chooser: graphChooser({ A: [] }),
        }),
      ).rejects.toThrow(/^implementSpec: the sandbox has no `gh` on its PATH/u);
      expect(git(origin, "branch", "--format=%(refname:short)")).toBe(
        "integration\nmain",
      );
      await expect(work(sandbox)).resolves.toStrictEqual([]);
    });

    it.each([
      {
        name: "implement",
        start: async (sandbox: Sandbox) =>
          implement.start(sandbox, {
            repo: origin,
            githubToken: TOKEN,
            skillsContext: GITHUB,
            ticket: "42",
          }),
      },
      {
        name: "review",
        start: async (sandbox: Sandbox) =>
          review.start(sandbox, {
            repo: origin,
            githubToken: TOKEN,
            skillsContext: GITHUB,
            pr: 5,
          }),
      },
      {
        name: "merge",
        start: async (sandbox: Sandbox) =>
          merge.start(sandbox, {
            repo: origin,
            githubToken: TOKEN,
            skillsContext: GITHUB,
            from: 5,
            into: "integration",
          }),
      },
    ])("$name rejects before it clones", async ({ name, start }) => {
      const sandbox = await withoutGh();

      await expect(start(sandbox)).rejects.toThrow(
        new RegExp(`^${name}: the sandbox has no \`gh\` on its PATH`, "u"),
      );
      await expect(work(sandbox)).resolves.toStrictEqual([]);
    });

    it("merge from a branch and general start without gh", async () => {
      const sandbox = await withoutGh();

      const merging = await merge.start(sandbox, {
        repo: origin,
        githubToken: TOKEN,
        skillsContext: GITHUB,
        from: "main",
        into: "integration",
        name: "merge-branch",
      });
      await merging.wait().catch(() => undefined);
      const generic = await general.start(sandbox, {
        prompt: "Say ok.",
        skillsContext: GITHUB,
      });
      await expect(generic.wait()).resolves.toMatchObject({
        finalMessage: "ok",
      });
    });
  },
);
