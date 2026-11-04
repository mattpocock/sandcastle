import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  FinishReport,
  OutputMap,
  Sandbox,
  SucceededDetachedWork,
} from "@ai-hero/sandcastle/v1";
import { createSandbox, verifyFinishReport } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type { ImplementInput } from "@ai-hero/sandcastle/v1/tasks";
import { implement } from "@ai-hero/sandcastle/v1/tasks";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import { bareRepo, stubClaude } from "./helpers/taskWorld.js";

// The bundled `implement` task through `/v1/tasks`, on the fake sandbox with a
// local bare repo standing in for GitHub and a stub `claude` on the sandbox's
// PATH that records its prompt and argv. POSIX only, like the other task tests.

const TOKEN = "ghs_implementtesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const LINEAR = {
  tracker: {
    kind: "custom",
    name: "Linear",
    instructions: "Read a ticket with `linear issue view <id>`.",
  },
} as const;

/** A final message carrying a valid `implementResult`. */
const reported = (branch: string): string =>
  `Opened the PR.\n<implementResult>${JSON.stringify({
    status: "pr-opened",
    branch,
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

describe.skipIf(process.platform === "win32")("the implement task (v1)", () => {
  let rootDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();
  let origin = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-implement-"));
    provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
    origin = await bareRepo(rootDir);
  });

  let receivers: FinishReportReceiver[] = [];

  afterEach(async () => {
    await provider.closeAll();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
    await rm(rootDir, { recursive: true, force: true });
  });

  const workOf = (sandbox: Sandbox, ...rest: string[]): string =>
    path.join(provider.pathOf(sandbox.sandboxId), "work", ...rest);

  const skillOf = async (sandbox: Sandbox, file: string): Promise<string> =>
    readFile(
      path.join(
        provider.pathOf(sandbox.sandboxId),
        "home",
        ".claude",
        "skills",
        file,
      ),
      "utf8",
    );

  it("creates a branch, installs its five skills and starts with /implement and the ticket", async () => {
    const claude = await stubClaude(path.join(rootDir, "agent"), [
      init("s-implement"),
      result(reported("sandcastle/implement-42")),
    ]);
    await using sandbox = await createSandbox({
      provider,
      env: claude.env,
      timeLimitMinutes: implement.limits.timeLimitMinutes,
    });

    const spawned = await implement.start(sandbox, {
      repo: origin,
      ticket: "42",
      githubToken: TOKEN,
      skillsContext: GITHUB,
    });
    const done = await spawned.wait();
    const prompt = await claude.read("agent-prompt.txt");

    expect(spawned.name).toBe("implement");
    expect(done.output.status).toBe("pr-opened");
    const branch = git(workOf(sandbox, "widgets"), "branch", "--show-current");
    expect(branch).not.toBe("main");
    expect(git(workOf(sandbox, "widgets"), "rev-parse", "HEAD")).toBe(
      git(origin, "rev-parse", "main"),
    );
    expect(prompt.startsWith("/implement 42")).toBe(true);
    expect(prompt).toContain(branch);
    expect(prompt).toContain("code-review");
    expect(prompt).toContain("Never merge");
    await expect(claude.read("agent-argv.txt")).resolves.toContain(
      "--model opus",
    );
    const names = ["implement", "tdd", "codebase-design", "code-review", "pr"];
    const skills = await Promise.all(
      names.map(async (name) => skillOf(sandbox, `${name}/SKILL.md`)),
    );
    expect(
      skills.map((skill) => /\nname: (?<name>.+)\n/u.exec(skill)?.groups?.name),
    ).toStrictEqual(names);
  });

  /** The input every test shares: the bare repo, a token and a GitHub tracker. */
  const base = () =>
    ({ repo: origin, githubToken: TOKEN, skillsContext: GITHUB }) as const;

  /** Starts implement on a stub that records its run, and waits for the session's result. */
  const run = async (input: ImplementInput) => {
    const claude = await stubClaude(path.join(rootDir, "agent"), [
      init("s-run"),
      result(reported("b")),
    ]);
    const sandbox = await createSandbox({
      provider,
      env: claude.env,
      timeLimitMinutes: implement.limits.timeLimitMinutes,
    });
    const spawned = await implement.start(sandbox, input);
    const done = await spawned.wait();
    const prompt = await claude.read("agent-prompt.txt");
    return { sandbox, claude, done, prompt };
  };

  it("starts round 2 as a fresh session on the given branch, with the review's comments in the prompt", async () => {
    const seed = path.join(rootDir, "seed");
    git(
      seed,
      "switch",
      "--quiet",
      "--create",
      "sandcastle/implement-42-round1",
    );
    await writeFile(path.join(seed, "widget.ts"), "export const widget = 1;\n");
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
      "round 1",
    );
    git(seed, "push", "--quiet", origin, "HEAD");
    const feedback = "widget.ts: name the constant `WIDGET_COUNT`.";

    const { sandbox, claude, prompt } = await run({
      ...base(),
      ticket: "42",
      branch: "sandcastle/implement-42-round1",
      feedback,
    });

    const clone = workOf(sandbox, "widgets");
    expect(git(clone, "branch", "--show-current")).toBe(
      "sandcastle/implement-42-round1",
    );
    expect(git(clone, "rev-parse", "HEAD")).toBe(
      git(seed, "rev-parse", "HEAD"),
    );
    expect(prompt.startsWith("/implement 42")).toBe(true);
    expect(prompt).toContain(feedback);
    expect(prompt).toContain("round 2");
    await expect(claude.read("agent-argv.txt")).resolves.not.toContain(
      "--resume",
    );
  });

  it("rejects a branch the remote doesn't have", async () => {
    await expect(
      run({ ...base(), ticket: "42", branch: "no-such-branch" }),
    ).rejects.toThrow(/no-such-branch/u);
  });

  it("takes a prompt instead of a ticket, and gives a new branch a local git identity", async () => {
    const { sandbox, prompt } = await run({
      ...base(),
      prompt: "Add a CONTRIBUTING.md.",
    });

    expect(prompt.startsWith("/implement Add a CONTRIBUTING.md.")).toBe(true);
    const clone = workOf(sandbox, "widgets");
    expect(git(clone, "branch", "--show-current")).toMatch(
      /^sandcastle\/implement-/u,
    );
    expect(git(clone, "config", "user.name")).not.toBe("");
  });

  it("rules out a ticket and a prompt together, and feedback without a branch", () => {
    // @ts-expect-error: a ticket or a prompt, not both.
    const both: ImplementInput = {
      ...base(),
      ticket: "42",
      prompt: "Also this.",
    };
    // @ts-expect-error: feedback is for a round on an existing branch.
    const stray: ImplementInput = {
      ...base(),
      ticket: "42",
      feedback: "Fix it.",
    };
    expect([both, stray]).toHaveLength(2);
  });

  it("tells a headless agent how to finish: blocked on an unfetchable ticket, agent-chosen seams, PR evidence", async () => {
    const { prompt } = await run({ ...base(), ticket: "42" });

    expect(prompt).toContain("`blocked`");
    expect(prompt).toContain("Agent-chosen seams");
    expect(prompt).toContain("never screenshots");
    expect(prompt).toContain("<implementResult>");
    expect(prompt).toContain("# Issue tracker: GitHub");
    expect(prompt).toContain("No human is watching");
  });

  describe("its skills", () => {
    const installed = async (
      sandbox: Sandbox,
    ): Promise<Record<string, string>> => {
      const root = path.join(
        provider.pathOf(sandbox.sandboxId),
        "home",
        ".claude",
        "skills",
      );
      const files = await readdir(root, {
        recursive: true,
        withFileTypes: true,
      });
      const entries = await Promise.all(
        files
          .filter((file) => file.isFile())
          .map(async (file): Promise<[string, string]> => {
            const full = path.join(file.parentPath, file.name);
            return [path.relative(root, full), await readFile(full, "utf8")];
          }),
      );
      return Object.fromEntries(entries);
    };

    it("renders the GitHub tracker doc into the skills that fetch tickets", async () => {
      const { sandbox } = await run({ ...base(), ticket: "42" });

      expect(new Set(Object.keys(await installed(sandbox)))).toStrictEqual(
        new Set([
          "code-review/SKILL.md",
          "code-review/tracker.md",
          "codebase-design/DEEPENING.md",
          "codebase-design/DESIGN-IT-TWICE.md",
          "codebase-design/SKILL.md",
          "implement/SKILL.md",
          "implement/tracker.md",
          "pr/CREDITS.md",
          "pr/SKILL.md",
          "tdd/SKILL.md",
          "tdd/mocking.md",
          "tdd/tests.md",
        ]),
      );
      const doc = await skillOf(sandbox, "code-review/tracker.md");
      expect(doc.split("\n")[0]).toBe("# Issue tracker: GitHub");
      expect(doc).toContain("gh issue view <number>");
      await expect(skillOf(sandbox, "implement/SKILL.md")).resolves.toContain(
        "fetch it from the issue tracker described in [tracker.md](tracker.md)",
      );
      const review = await skillOf(sandbox, "code-review/SKILL.md");
      expect(review).toContain(
        "The issue tracker is described in the tracker doc, [tracker.md](tracker.md).",
      );
      expect(review).not.toContain("setup-matt-pocock-skills");
    });

    it("keeps implement a slash command only", async () => {
      const { sandbox } = await run({ ...base(), ticket: "42" });

      await expect(skillOf(sandbox, "implement/SKILL.md")).resolves.toContain(
        "\ndisable-model-invocation: true\n",
      );
    });

    it("changes only the tracker docs for a custom tracker", async () => {
      const first = await run({ ...base(), ticket: "42" });
      const second = await run({
        ...base(),
        skillsContext: LINEAR,
        ticket: "ENG-42",
      });
      const github = await installed(first.sandbox);
      const linear = await installed(second.sandbox);

      const trackerDocs = ["code-review/tracker.md", "implement/tracker.md"];
      for (const doc of trackerDocs) {
        expect(linear[doc]).toBe(
          "# Issue tracker: Linear\n\nRead a ticket with `linear issue view <id>`.",
        );
      }
      const rest = (tree: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(tree).filter(([file]) => !trackerDocs.includes(file)),
        );
      expect(rest(linear)).toStrictEqual(rest(github));
    });
  });

  it("validates a recorded run's implementResult through verifyFinishReport", async () => {
    const claude = await stubClaude(
      path.join(rootDir, "agent"),
      [init("s-report"), result(reported("sandcastle/implement-42"))],
      { waitForGo: true },
    );
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const secret = "whsec_aW1wbGVtZW50LXRlc3Qtc2VjcmV0LTAxMjM0NTY3ODk=";
    const sandbox = await createSandbox({
      provider,
      env: claude.env,
      timeLimitMinutes: implement.limits.timeLimitMinutes,
    });
    await implement.start(sandbox, { ...base(), ticket: "42" });
    await sandbox.detach({ finishReport: { url: hook.url, secret } });
    await claude.go();
    const delivery = await hook.first();

    const report = await verifyFinishReport({
      body: delivery.body,
      headers: delivery.headers,
      secret,
      outputs: implement.outputs,
    });

    const { output } = succeeded(report).sessions.implement;
    const pr: number | undefined = output.pr?.number;
    expect(pr).toBe(7);
    expect(output.status).toBe("pr-opened");
  });
});
