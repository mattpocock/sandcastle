import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ExecOptions,
  FinishReport,
  OutputMap,
  Sandbox,
  SucceededDetachedWork,
} from "@ai-hero/sandcastle/v1";
import { createSandbox, verifyFinishReport } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type { ReviewInput, ReviewResult } from "@ai-hero/sandcastle/v1/tasks";
import { review } from "@ai-hero/sandcastle/v1/tasks";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import {
  bareRepo,
  pullRequest,
  spied,
  stubClaude,
  stubGh,
} from "./helpers/taskWorld.js";

// The bundled `review` task through `/v1/tasks`, on the fake sandbox. A local
// bare repo with `refs/pull/7/head` stands in for GitHub, a stub `gh` answers
// `gh pr view`, and a stub `claude` records what it was run with. The fake
// sandbox needs `sh` and POSIX process groups, so these skip on Windows.

const TOKEN = "ghs_reviewtesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const PR = { number: 7, branch: "add-gadgets", file: "GADGETS.md" } as const;

const LINKED = {
  baseRefName: "main",
  headRefName: PR.branch,
  closingIssuesReferences: [
    { number: 12, url: "https://github.com/acme/widgets/issues/12" },
  ],
};

const APPROVED = {
  verdict: "approve",
  comments: [],
  summary: "Standards: 0 findings. Spec: 0 findings.",
};

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const reviewed = (value: unknown): string =>
  result(`Posted.\n<reviewResult>${JSON.stringify(value)}</reviewResult>`);

/** Starts `review` and waits for its session's result. */
const finished = async (sandbox: Sandbox, input: ReviewInput) => {
  const spawned = await review.start(sandbox, input);
  return spawned.wait();
};

/** The report's work, which must have succeeded. */
const succeeded = <O extends OutputMap>(
  report: FinishReport<O>,
): SucceededDetachedWork<O> => {
  if (report.data.status !== "succeeded") {
    throw new Error(`the review failed: ${report.data.failure.message}`);
  }
  return report.data;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

describe.skipIf(process.platform === "win32")("the review task (v1)", () => {
  let rootDir = "";
  let agentDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();
  let origin = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-review-"));
    agentDir = path.join(rootDir, "agent");
    provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
    origin = await bareRepo(rootDir);
    await pullRequest(rootDir, origin, PR);
  });

  afterEach(async () => {
    await provider.closeAll();
    await rm(rootDir, { recursive: true, force: true });
  });

  const workOf = (sandbox: Sandbox, ...rest: string[]): string =>
    path.join(provider.pathOf(sandbox.sandboxId), "work", ...rest);

  /** A sandbox whose `gh pr view` answers `view` and whose agent prints `lines`. */
  const world = async (
    view: unknown,
    lines: readonly string[] = [init("s-review"), reviewed(APPROVED)],
  ) => {
    const claude = await stubClaude(agentDir, lines);
    await stubGh(agentDir, view);
    const sandbox = await createSandbox({
      provider,
      env: claude.env,
      timeLimitMinutes: review.limits.timeLimitMinutes,
    });
    return { claude, sandbox };
  };

  const input = (extra: Partial<ReviewInput> = {}): ReviewInput => ({
    repo: origin,
    pr: PR.number,
    githubToken: TOKEN,
    skillsContext: GITHUB,
    ...extra,
  });

  it("checks out the pull request's branch and gives the fixed point and the linked ticket", async () => {
    const { claude, sandbox } = await world(LINKED);

    const spawned = await review.start(sandbox, input());
    await spawned.wait();
    const prompt = await claude.read("agent-prompt.txt");

    expect(spawned.name).toBe("review");
    const clone = workOf(sandbox, "widgets");
    expect(git(clone, "branch", "--show-current")).toBe(PR.branch);
    await expect(readFile(path.join(clone, PR.file), "utf8")).resolves.toBe(
      `${PR.branch}\n`,
    );
    await expect(claude.read("agent-cwd.txt")).resolves.toBe(
      `${await realpath(clone)}\n`,
    );
    expect(prompt.startsWith("/code-review ")).toBe(true);
    expect(prompt).toContain("The fixed point is `origin/main`");
    expect(prompt).toContain("#12 (https://github.com/acme/widgets/issues/12)");
    expect(prompt).not.toContain("no spec available");
  });

  it("says there is no spec when the pull request links no ticket", async () => {
    const { claude, sandbox } = await world({
      ...LINKED,
      closingIssuesReferences: [],
    });

    await finished(sandbox, input());

    const prompt = await claude.read("agent-prompt.txt");
    expect(prompt).toContain('report "no spec available"');
    expect(prompt).not.toContain("#12");
  });

  it("installs code-review alone, with the tracker doc rendered from the skills context", async () => {
    const { sandbox } = await world(LINKED);
    const skills = path.join(
      provider.pathOf(sandbox.sandboxId),
      "home",
      ".claude",
      "skills",
    );

    await finished(
      sandbox,
      input({
        skillsContext: {
          tracker: {
            kind: "custom",
            name: "Linear",
            instructions: "Read a ticket with `linear issue view <id>`.",
          },
        },
      }),
    );

    await expect(readdir(skills)).resolves.toStrictEqual(["code-review"]);
    await expect(
      readFile(path.join(skills, "code-review", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: code-review");
    await expect(
      readFile(path.join(skills, "code-review", "tracker.md"), "utf8"),
    ).resolves.toContain("Read a ticket with `linear issue view <id>`.");
  });

  it("runs Claude Code on Sonnet with every tool allowed, so code-review can spawn its sub-agents", async () => {
    const { claude, sandbox } = await world(LINKED);

    await finished(sandbox, input());

    const argv = await claude.read("agent-argv.txt");
    expect(argv).toContain("--model sonnet");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--disallowedTools");
    expect(argv).not.toContain("--permission-mode");
  });

  it("asks for one comment with the verdict and never approves, merges or pushes", async () => {
    const { claude, sandbox } = await world(LINKED);

    await finished(sandbox, input());

    const prompt = await claude.read("agent-prompt.txt");
    expect(prompt).toContain("exactly one comment on pull request #7");
    expect(prompt).toContain("`gh pr comment 7 --body-file <file>`");
    expect(prompt).toContain("never merge");
    expect(prompt).toContain("<reviewResult>");
    expect(prompt).toContain("No human is watching");
  });

  it("puts the token only in the env of the clone, the checkout and the session, and runs setup on the branch", async () => {
    const { claude, sandbox } = await world(LINKED);
    const calls: ExecOptions[] = [];

    await finished(
      spied(sandbox, calls),
      input({
        setup: [
          `git branch --show-current > "${agentDir}/setup-branch.txt"`,
          `env > "${agentDir}/setup-env.txt"`,
        ],
      }),
    );

    const withToken = calls
      .filter((call) => call.env?.GH_TOKEN === TOKEN)
      .map((call) => call.command);
    expect(withToken).toStrictEqual([
      expect.stringContaining(" clone "),
      expect.stringMatching(/^gh pr view 7 /u),
      expect.stringMatching(/^git fetch /u),
    ]);
    expect(calls.map((call) => call.command).join("\n")).not.toContain(TOKEN);
    await expect(claude.read("gh-calls.txt")).resolves.toBe(
      `pr view 7 --json baseRefName,headRefName,closingIssuesReferences token=${TOKEN}\n`,
    );
    await expect(claude.read("setup-branch.txt")).resolves.toBe(
      `${PR.branch}\n`,
    );
    await expect(claude.read("setup-env.txt")).resolves.not.toContain(TOKEN);
    await expect(claude.read("agent-env.txt")).resolves.toContain(
      `GH_TOKEN=${TOKEN}`,
    );
  });

  it("rejects before the session when gh doesn't describe the pull request", async () => {
    const { claude, sandbox } = await world({ message: "Not Found" });

    await expect(review.start(sandbox, input())).rejects.toThrow(
      /gh pr view 7/u,
    );
    await expect(claude.read("agent-prompt.txt")).rejects.toThrow(/ENOENT/u);
  });

  it("rejects a pr that isn't a pull request number", async () => {
    const { sandbox } = await world(LINKED);

    await expect(review.start(sandbox, input({ pr: 0 }))).rejects.toThrow(
      RangeError,
    );
  });

  // A detached run spawns the supervisor and delivers over HTTP, which is
  // slow under coverage; the timeout is slack, not a wait.
  describe("review.outputs", { timeout: 30_000 }, () => {
    let receivers: FinishReportReceiver[] = [];

    afterEach(async () => {
      await Promise.all(receivers.map(async (made) => made.close()));
      receivers = [];
    });

    const detachedReport = async (value: unknown) => {
      const claude = await stubClaude(
        agentDir,
        [init("s-detached"), reviewed(value)],
        { waitForGo: true },
      );
      await stubGh(agentDir, LINKED);
      const hook = await finishReportReceiver();
      receivers.push(hook);
      const secret = "whsec_cmV2aWV3LXRlc3Qtc2VjcmV0LTAxMjM0NTY3ODk=";
      const sandbox = await createSandbox({
        provider,
        env: claude.env,
        timeLimitMinutes: review.limits.timeLimitMinutes,
      });
      await review.start(sandbox, input());
      await sandbox.detach({ finishReport: { url: hook.url, secret } });
      await claude.go();
      const delivery = await hook.first();
      return { body: delivery.body, headers: delivery.headers, secret };
    };

    it("validates and types reviewResult in the finish report", async () => {
      const requested = {
        verdict: "changes-requested",
        comments: ["Spec: src/widgets.ts never handles an empty list (#12)."],
        summary: "Standards: 0 findings. Spec: 1 finding, the empty list.",
      };
      const delivered = await detachedReport(requested);

      const report = await verifyFinishReport({
        ...delivered,
        outputs: review.outputs,
      });

      const returned: ReviewResult = succeeded(report).sessions.review.output;
      expect(returned).toStrictEqual(requested);
    });
  });
});
