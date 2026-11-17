import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import { implement, implementSpec } from "@ai-hero/sandcastle/v1/tasks";
import {
  fixesReview,
  git,
  graphChooser,
  opensPr,
  pushesMerge,
  requestsChanges,
  REVIEW_AGENT,
  stubAgents,
} from "./helpers/specWorld.js";
import { bareRepo, privateRemote, stubClaude } from "./helpers/taskWorld.js";

// The bundled tasks against a private repo, on the fake sandbox. A private
// remote over a local bare repo stands in for a private GitHub repo: it asks
// git's credential helpers for the token, as GitHub does, and refuses any
// clone, fetch, push or `ls-remote` that doesn't bring it. A public repo
// fetches without one, which is how a git command run without `GH_TOKEN`
// after the clone went unnoticed. POSIX only, like the other task tests.

const TOKEN = "ghs_privaterepotesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const IMPLEMENTED = JSON.stringify({
  type: "result",
  is_error: false,
  result: `Opened the PR.\n<implementResult>${JSON.stringify({
    status: "pr-opened",
    branch: "b",
    pr: { number: 7, url: "https://github.com/o/widgets/pull/7" },
    summary: "Added the widget.",
  })}</implementResult>`,
});

describe.skipIf(process.platform === "win32")(
  "bundled tasks on a private repo (v1)",
  { timeout: 60_000 },
  () => {
    let rootDir = "";
    let agentDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let origin = "";

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-private-"));
      agentDir = path.join(rootDir, "agent");
      provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
      origin = await bareRepo(rootDir);
    });

    afterEach(async () => {
      await provider.closeAll();
      await rm(rootDir, { recursive: true, force: true });
    });

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
        "-qm",
        "f",
      );
      git(seed, "push", "--quiet", origin, "HEAD");
      return git(seed, "rev-parse", "HEAD");
    };

    it("refuses a clone that doesn't bring the token, as a private GitHub repo does", async () => {
      const remote = await privateRemote(agentDir, origin, TOKEN);
      const claude = await stubClaude(agentDir, []);
      const sandbox = await createSandbox({ provider, env: claude.env });

      const cloned = await sandbox.exec({
        command: `git clone --quiet -- '${remote.repo}' anonymous`,
        allowFailure: true,
      });

      expect(cloned.exitCode).not.toBe(0);
      expect(cloned.stderr).toContain("Invalid username or token");
      await expect(remote.operations()).resolves.toStrictEqual([
        "refused git-upload-pack",
      ]);
    });

    it("implement fetches its base with the token", async () => {
      const tip = await pushFeature();
      const remote = await privateRemote(agentDir, origin, TOKEN);
      const claude = await stubClaude(agentDir, [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
        IMPLEMENTED,
      ]);
      const sandbox = await createSandbox({
        provider,
        env: claude.env,
        timeLimitMinutes: implement.limits.timeLimitMinutes,
      });

      const spawned = await implement.start(sandbox, {
        repo: remote.repo,
        githubToken: TOKEN,
        skillsContext: GITHUB,
        ticket: "42",
        base: "feature",
      });
      await spawned.wait();

      const clone = path.join(
        provider.pathOf(sandbox.sandboxId),
        "work",
        "widgets",
      );
      expect(git(clone, "rev-parse", "HEAD")).toBe(tip);
      await expect(remote.operations()).resolves.toStrictEqual([
        "git-upload-pack",
        "git-upload-pack",
      ]);
    });

    it("implementSpec builds, merges, reviews and fixes a spec with every git operation authenticated", async () => {
      const remote = await privateRemote(agentDir, origin, TOKEN);
      const agents = await stubAgents(agentDir);
      await agents.script("implement-A", opensPr("A", 1));
      await agents.script("implement-B", opensPr("B", 2));
      await agents.script("merge-A", pushesMerge());
      await agents.script("merge-B", pushesMerge());
      await agents.script(REVIEW_AGENT, requestsChanges(["Say why."]));
      await agents.script("implement-review-fixes", fixesReview(100));
      const sandbox = await createSandbox({
        provider,
        env: agents.env,
        timeLimitMinutes: implementSpec.limits.timeLimitMinutes,
      });

      const result = await implementSpec.run(sandbox, {
        repo: remote.repo,
        spec: "7",
        githubToken: TOKEN,
        skillsContext: GITHUB,
        chooser: graphChooser({ A: [], B: ["A"] }),
      });

      expect(result).toMatchObject({
        status: "complete",
        merged: ["A", "B"],
        stuck: [],
        pr: { number: 100 },
        review: { verdict: "changes-requested", fixed: true },
      });
      expect(
        new Set(
          git(origin, "ls-tree", "--name-only", result.branch).split("\n"),
        ),
      ).toStrictEqual(new Set(["A.md", "B.md", "FIXES.md", "README.md"]));
      const operations = await remote.operations();
      expect(operations.filter((op) => op.startsWith("refused"))).toStrictEqual(
        [],
      );
      expect(operations).toContain("git-receive-pack");
    });
  },
);
