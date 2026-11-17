import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  FinishReport,
  OutputMap,
  Sandbox,
  SucceededDetachedWork,
} from "@ai-hero/sandcastle/v1";
import {
  createSandbox,
  Output,
  verifyFinishReport,
} from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import {
  general,
  implement,
  merge,
  review,
} from "@ai-hero/sandcastle/v1/tasks";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import {
  bareRepo,
  pullRequest,
  stubClaude,
  stubGh,
} from "./helpers/taskWorld.js";

// Bundled tasks side by side on one handle: each start names its session,
// clones into a directory of that name, and refuses a name already running.
// On the fake sandbox, with a local bare repo standing in for GitHub and a
// stub `claude` on the sandbox's PATH. POSIX only, like the other task tests.

const TOKEN = "ghs_sidebysidetesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const VERDICT = Output.string({ tag: "verdict" });

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const REPORTED = `Opened the PR.\n<implementResult>${JSON.stringify({
  status: "pr-opened",
  branch: "sandcastle/implement-b",
  pr: { number: 7, url: "https://github.com/o/widgets/pull/7" },
  summary: "Added the widget.",
})}</implementResult>`;

/** The report's work, which must have succeeded. */
const succeeded = <O extends OutputMap>(
  report: FinishReport<O>,
): SucceededDetachedWork<O> => {
  if (report.data.status !== "succeeded") {
    throw new Error(`the work failed: ${report.data.failure.message}`);
  }
  return report.data;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

describe.skipIf(process.platform === "win32")(
  "bundled tasks side by side on one handle (v1)",
  () => {
    let rootDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let origin = "";
    let receivers: Awaited<ReturnType<typeof finishReportReceiver>>[] = [];

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-side-"));
      provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
      origin = await bareRepo(rootDir);
    });

    afterEach(async () => {
      await provider.closeAll();
      await Promise.all(receivers.map(async (made) => made.close()));
      receivers = [];
      await rm(rootDir, { recursive: true, force: true });
    });

    const workOf = (sandbox: Sandbox, ...rest: string[]): string =>
      path.join(provider.pathOf(sandbox.sandboxId), "work", ...rest);

    /** A sandbox whose agent prints `lines`, holding the last until `go()`. */
    const world = async (lines: readonly string[]) => {
      const claude = await stubClaude(path.join(rootDir, "agent"), lines, {
        waitForGo: true,
      });
      const sandbox = await createSandbox({
        provider,
        env: claude.env,
        timeLimitMinutes: implement.limits.timeLimitMinutes,
      });
      return { claude, sandbox };
    };

    const implementInput = (name: string, ticket: string) =>
      ({
        name,
        ticket,
        repo: origin,
        githubToken: TOKEN,
        skillsContext: GITHUB,
      }) as const;

    it("runs two named implement starts at once, each in its own clone, and verifies both by name", async () => {
      const { claude, sandbox } = await world([
        init("s-two"),
        result(REPORTED),
      ]);
      const hook = await finishReportReceiver();
      receivers.push(hook);
      const secret = "whsec_c2lkZS1ieS1zaWRlLXRlc3Qtc2VjcmV0LTAxMjM=";

      const spawned = await Promise.all([
        implement.start(sandbox, implementInput("implement-1", "1")),
        implement.start(sandbox, implementInput("implement-2", "2")),
      ]);
      await sandbox.detach({ finishReport: { url: hook.url, secret } });
      await claude.go();
      const delivery = await hook.first();
      const report = await verifyFinishReport({
        body: delivery.body,
        headers: delivery.headers,
        secret,
        outputs: {
          ...implement.outputs("implement-1"),
          ...implement.outputs("implement-2"),
        },
      });

      expect(spawned.map((process) => process.name)).toStrictEqual([
        "implement-1",
        "implement-2",
      ]);
      const branches = ["implement-1", "implement-2"].map((name) =>
        git(workOf(sandbox, name), "branch", "--show-current"),
      );
      expect(branches[0]).toMatch(/^sandcastle\/implement-1-/u);
      expect(branches[1]).toMatch(/^sandcastle\/implement-2-/u);
      await expect(readdir(workOf(sandbox))).resolves.not.toContain("widgets");
      const { sessions } = succeeded(report);
      const statuses: string[] = [
        sessions["implement-1"].output.status,
        sessions["implement-2"].output.status,
      ];
      expect(statuses).toStrictEqual(["pr-opened", "pr-opened"]);
    });

    it("rejects a start whose name is already running before it clones", async () => {
      const { sandbox } = await world([init("s-taken"), result("ok")]);
      await general.start(sandbox, {
        name: "ticket-1",
        prompt: "Hold on.",
        skillsContext: GITHUB,
      });

      await expect(
        implement.start(sandbox, implementInput("ticket-1", "1")),
      ).rejects.toThrow(
        /implement: a session named "ticket-1" is already running/u,
      );
      await expect(readdir(workOf(sandbox))).resolves.toStrictEqual([]);
    });

    it("rejects the second of two starts of one name made at once", async () => {
      const { sandbox } = await world([init("s-race"), result(REPORTED)]);

      const started = await Promise.allSettled([
        implement.start(sandbox, implementInput("implement-1", "1")),
        implement.start(sandbox, implementInput("implement-1", "2")),
      ]);

      expect(started.map((settled) => settled.status)).toStrictEqual([
        "fulfilled",
        "rejected",
      ]);
      await expect(readdir(workOf(sandbox))).resolves.toStrictEqual([
        "implement-1",
      ]);
    });

    it("rejects a name that isn't one plain directory name before it clones", async () => {
      const { sandbox } = await world([init("s-bad"), result("ok")]);

      await Promise.all(
        ["", "../up", "a/b", ".", "-x"].map(async (name) =>
          expect(
            implement.start(sandbox, implementInput(name, "1")),
          ).rejects.toThrow(TypeError),
        ),
      );
      await expect(readdir(workOf(sandbox))).resolves.toStrictEqual([]);
    });

    it("names general's session and clone, and keys its Output by that name", async () => {
      const { claude, sandbox } = await world([
        init("s-general"),
        result("<verdict>green</verdict>"),
      ]);

      const spawned = await general.start(sandbox, {
        name: "general-2",
        prompt: "Is the build green?",
        repo: origin,
        skillsContext: GITHUB,
        output: VERDICT,
      });
      await claude.go();
      const done = await spawned.wait();

      expect(spawned.name).toBe("general-2");
      const verdict: string = done.output;
      expect(verdict).toBe("green");
      await expect(readdir(workOf(sandbox))).resolves.toStrictEqual([
        "general-2",
      ]);
      const outputs = general.outputs(VERDICT, "general-2");
      expect(Object.keys(outputs)).toStrictEqual(["general-2"]);
      expect(outputs["general-2"]).toBe(VERDICT);
    });

    it("names review's session and clone, and keys its output by that name", async () => {
      const pr = { number: 7, branch: "add-gadgets", file: "GADGETS.md" };
      await pullRequest(rootDir, origin, pr);
      await stubGh(path.join(rootDir, "agent"), {
        baseRefName: "main",
        headRefName: pr.branch,
        closingIssuesReferences: [],
      });
      const { claude, sandbox } = await world([
        init("s-review"),
        result(
          `<reviewResult>${JSON.stringify({ verdict: "approve", comments: [], summary: "Fine." })}</reviewResult>`,
        ),
      ]);

      const spawned = await review.start(sandbox, {
        name: "review-7",
        repo: origin,
        pr: pr.number,
        githubToken: TOKEN,
        skillsContext: GITHUB,
      });
      await claude.go();
      await spawned.wait();

      expect(spawned.name).toBe("review-7");
      expect(git(workOf(sandbox, "review-7"), "branch", "--show-current")).toBe(
        pr.branch,
      );
      expect(Object.keys(review.outputs("review-7"))).toStrictEqual([
        "review-7",
      ]);
      expect(Object.keys(review.outputs())).toStrictEqual(["review"]);
      expect(Object.keys(implement.outputs())).toStrictEqual(["implement"]);
    });

    describe("merge", () => {
      const mergeInput = async (name: string) => {
        execFileSync("git", ["-C", origin, "branch", "integration", "main"]);
        await pullRequest(rootDir, origin, {
          number: 3,
          branch: "a",
          file: "A.md",
        });
        return {
          name,
          repo: origin,
          from: "a",
          into: "integration",
          githubToken: TOKEN,
          skillsContext: GITHUB,
        } as const;
      };

      it("clones a named merge into a directory of its name", async () => {
        const merged = { status: "merged", into: "integration", summary: "ok" };
        const { claude, sandbox } = await world([
          init("s-merge"),
          result(`<mergeResult>${JSON.stringify(merged)}</mergeResult>`),
        ]);

        const spawned = await merge.start(sandbox, await mergeInput("merge-3"));
        await claude.go();
        await spawned.wait();

        expect(spawned.name).toBe("merge-3");
        await expect(readdir(workOf(sandbox))).resolves.toStrictEqual([
          "merge-3",
        ]);
        expect(
          git(workOf(sandbox, "merge-3"), "branch", "--show-current"),
        ).toBe("integration");
      });

      it("rejects a merge whose name is already running before it clones", async () => {
        const { sandbox } = await world([init("s-merge-taken"), result("ok")]);
        await general.start(sandbox, {
          name: "merge-3",
          prompt: "Hold on.",
          skillsContext: GITHUB,
        });

        await expect(
          merge.start(sandbox, await mergeInput("merge-3")),
        ).rejects.toThrow(
          /merge: a session named "merge-3" is already running/u,
        );
        await expect(readdir(workOf(sandbox))).resolves.toStrictEqual([]);
      });
    });
  },
);
