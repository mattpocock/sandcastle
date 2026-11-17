import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import type { MergeInput, MergeResult } from "@ai-hero/sandcastle/v1/tasks";
import { merge } from "@ai-hero/sandcastle/v1/tasks";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import {
  bareRepo,
  pullRequest,
  spied,
  stubClaude,
  stubGh,
} from "./helpers/taskWorld.js";

// The bundled `merge` task through `/v1/tasks`, on the fake sandbox. A local
// bare repo stands in for GitHub, with an `integration` branch to merge into;
// a stub `claude` records its prompt and runs a script in the clone, standing
// in for the agent's merge, conflict resolution and push. POSIX only, like
// the other task tests.

const TOKEN = "ghs_mergetesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const MERGED: MergeResult = {
  status: "merged",
  into: "integration",
  commit: "0123456789abcdef0123456789abcdef01234567",
  summary: "Merged a into integration; the tests pass.",
};

const reported = (value: MergeResult = MERGED): string =>
  result(`Pushed.\n<mergeResult>${JSON.stringify(value)}</mergeResult>`);

const PUSH = "git push --quiet origin integration";

/** The report's work, which must have succeeded. */
const succeeded = <O extends OutputMap>(
  report: FinishReport<O>,
): SucceededDetachedWork<O> => {
  if (report.data.status !== "succeeded") {
    throw new Error(`the merge failed: ${report.data.failure.message}`);
  }
  return report.data;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** Starts `merge` and waits for its session's result. */
const finished = async (sandbox: Sandbox, input: MergeInput) => {
  const spawned = await merge.start(sandbox, input);
  return spawned.wait();
};

/** Pushes a commit writing `content` to `file` onto `branch`, created from `base` when new. */
const commitOn = async (
  dir: string,
  origin: string,
  change: {
    readonly branch: string;
    readonly base: string;
    readonly file: string;
    readonly content: string;
  },
): Promise<string> => {
  const work = await mkdtemp(path.join(dir, "commit-"));
  execFileSync("git", ["clone", "--quiet", origin, work], { stdio: "ignore" });
  const author = ["-c", "user.name=t", "-c", "user.email=t@t"];
  git(
    work,
    "checkout",
    "--quiet",
    "-B",
    change.branch,
    `origin/${change.base}`,
  );
  await writeFile(path.join(work, change.file), change.content);
  git(work, "add", ".");
  git(work, ...author, "commit", "--quiet", "-m", `Change ${change.file}`);
  git(work, "push", "--quiet", "origin", `HEAD:refs/heads/${change.branch}`);
  return git(work, "rev-parse", "HEAD");
};

describe.skipIf(process.platform === "win32")("the merge task (v1)", () => {
  let rootDir = "";
  let agentDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();
  let origin = "";
  let receivers: FinishReportReceiver[] = [];

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-merge-"));
    agentDir = path.join(rootDir, "agent");
    provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
    origin = await bareRepo(rootDir);
    git(origin, "branch", "integration", "main");
  });

  afterEach(async () => {
    await provider.closeAll();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
    await rm(rootDir, { recursive: true, force: true });
  });

  const workOf = (sandbox: Sandbox, ...rest: string[]): string =>
    path.join(provider.pathOf(sandbox.sandboxId), "work", ...rest);

  /** A sandbox whose stub agent runs `script` in the clone, then prints `lines`. */
  const world = async (
    script: string,
    lines: readonly string[] = [init("s-merge"), reported()],
    options: { readonly waitForGo?: boolean } = {},
  ) => {
    const claude = await stubClaude(agentDir, lines, { ...options, script });
    const sandbox = await createSandbox({
      provider,
      env: claude.env,
      timeLimitMinutes: merge.limits.timeLimitMinutes,
    });
    return { claude, sandbox };
  };

  const input = (extra: Partial<MergeInput> = {}): MergeInput => ({
    repo: origin,
    from: "a",
    into: "integration",
    githubToken: TOKEN,
    skillsContext: GITHUB,
    ...extra,
  });

  it("merges a clean branch with a merge commit, and the agent pushes it; the prompt names both", async () => {
    const tip = await commitOn(rootDir, origin, {
      branch: "a",
      base: "main",
      file: "A.md",
      content: "a\n",
    });
    const before = git(origin, "rev-parse", "integration");
    const { claude, sandbox } = await world(PUSH);

    const spawned = await merge.start(sandbox, input());
    const done = await spawned.wait();
    const prompt = await claude.read("agent-prompt.txt");

    expect(spawned.name).toBe("merge");
    expect(done.output).toStrictEqual(MERGED);
    expect(prompt).toContain("`a`");
    expect(prompt).toContain("`integration`");
    expect(prompt).toContain("Never force-push");
    expect(git(origin, "rev-parse", "integration^1")).toBe(before);
    expect(git(origin, "rev-parse", "integration^2")).toBe(tip);
    expect(git(origin, "show", "integration:A.md")).toBe("a");
    await expect(claude.read("agent-argv.txt")).resolves.toContain(
      "--model sonnet",
    );
  });

  it("aborts a conflicted merge before setup, and the agent resolves it into a merge commit on integration", async () => {
    const ours = await commitOn(rootDir, origin, {
      branch: "integration",
      base: "integration",
      file: "README.md",
      content: "# Widgets, from integration\n",
    });
    const theirs = await commitOn(rootDir, origin, {
      branch: "a",
      base: "main",
      file: "README.md",
      content: "# Widgets, from a\n",
    });
    const resolve = [
      "git merge --no-ff --no-edit origin/a",
      String.raw`printf '# Widgets, from integration and a\n' > README.md`,
      "git add README.md",
      "git commit --quiet --no-edit",
      PUSH,
    ].join("\n");
    const { claude, sandbox } = await world(resolve);

    const clean = "test ! -f .git/MERGE_HEAD";
    const done = await finished(sandbox, input({ setup: [clean] }));
    const prompt = await claude.read("agent-prompt.txt");

    expect(done.output.status).toBe("merged");
    expect(prompt).toContain(`\`${clean}\``);
    expect(prompt).toContain("README.md");
    expect(prompt).toContain("both sides' intent");
    expect(git(origin, "rev-parse", "integration^1")).toBe(ours);
    expect(git(origin, "rev-parse", "integration^2")).toBe(theirs);
    expect(git(origin, "show", "integration:README.md")).toBe(
      "# Widgets, from integration and a",
    );
  });

  it("merges a pull request's head when from is its number, as review checks it out", async () => {
    await pullRequest(rootDir, origin, {
      number: 7,
      branch: "add-gadgets",
      file: "GADGETS.md",
    });
    await stubGh(agentDir, {
      baseRefName: "integration",
      headRefName: "add-gadgets",
      closingIssuesReferences: [],
    });
    const { claude, sandbox } = await world(PUSH);

    await finished(sandbox, input({ from: 7 }));
    const prompt = await claude.read("agent-prompt.txt");

    expect(prompt).toContain("pull request #7");
    expect(git(origin, "rev-parse", "integration^2")).toBe(
      git(origin, "rev-parse", "refs/pull/7/head"),
    );
    expect(git(origin, "log", "-1", "--format=%s", "integration")).toBe(
      "Merge pull request #7 from add-gadgets",
    );
    await expect(
      readFile(path.join(agentDir, "gh-calls.txt"), "utf8"),
    ).resolves.toContain(`pr view 7 `);
  });

  it("tells the agent there's nothing to merge when into already has from", async () => {
    git(origin, "branch", "a", "integration");
    const { claude, sandbox } = await world("");

    await finished(sandbox, input());

    await expect(claude.read("agent-prompt.txt")).resolves.toContain(
      "nothing to merge",
    );
    expect(git(workOf(sandbox, "widgets"), "branch", "--show-current")).toBe(
      "integration",
    );
  });

  it("rejects into = the default branch before it clones anything", async () => {
    await commitOn(rootDir, origin, {
      branch: "a",
      base: "main",
      file: "A.md",
      content: "a\n",
    });
    const { sandbox } = await world(PUSH);
    const calls: ExecOptions[] = [];

    await expect(
      merge.start(spied(sandbox, calls), input({ into: "main" })),
    ).rejects.toThrow(/default branch/u);

    expect(calls.map((call) => call.command).join("\n")).not.toMatch(
      /git\b.*\bclone\b/u,
    );
    await expect(readdir(workOf(sandbox))).resolves.toStrictEqual([]);
  });

  it("rejects a from branch the remote doesn't have", async () => {
    const { sandbox } = await world(PUSH);

    await expect(
      merge.start(sandbox, input({ from: "missing" })),
    ).rejects.toThrow(/missing/u);
  });

  it("names its session and its output after name", async () => {
    await commitOn(rootDir, origin, {
      branch: "a",
      base: "main",
      file: "A.md",
      content: "a\n",
    });
    const { sandbox } = await world(PUSH);

    const spawned = await merge.start(sandbox, input({ name: "merge-42" }));
    await spawned.wait();

    expect(spawned.name).toBe("merge-42");
    expect(Object.keys(merge.outputs("merge-42"))).toStrictEqual(["merge-42"]);
    expect(Object.keys(merge.outputs())).toStrictEqual(["merge"]);
  });

  it("has Sonnet's 40-minute limits and no skills", async () => {
    await commitOn(rootDir, origin, {
      branch: "a",
      base: "main",
      file: "A.md",
      content: "a\n",
    });
    const { sandbox } = await world(PUSH);

    await finished(sandbox, input());

    expect(merge.limits).toStrictEqual({
      timeLimitMinutes: 40,
      deadlineMinutes: 30,
    });
    await expect(
      readdir(
        path.join(
          provider.pathOf(sandbox.sandboxId),
          "home",
          ".claude",
          "skills",
        ),
      ),
    ).rejects.toThrow(/ENOENT/u);
  });

  it("validates a recorded run's mergeResult through verifyFinishReport", async () => {
    await commitOn(rootDir, origin, {
      branch: "a",
      base: "main",
      file: "A.md",
      content: "a\n",
    });
    const conflicted: MergeResult = {
      status: "conflict-unresolved",
      into: "integration",
      summary: "The two sides disagree on the README.",
    };
    const { claude, sandbox } = await world(
      "",
      [init("s-report"), reported(conflicted)],
      { waitForGo: true },
    );
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const secret = "whsec_bWVyZ2UtdGVzdC1zZWNyZXQtMDEyMzQ1Njc4OWFiY2Q=";
    await merge.start(sandbox, input());
    await sandbox.detach({ finishReport: { url: hook.url, secret } });
    await claude.go();
    const delivery = await hook.first();

    const report = await verifyFinishReport({
      body: delivery.body,
      headers: delivery.headers,
      secret,
      outputs: merge.outputs(),
    });

    const { output } = succeeded(report).sessions.merge;
    const commit: string | undefined = output.commit;
    expect(commit).toBeUndefined();
    expect(output.status).toBe("conflict-unresolved");
  });
});
