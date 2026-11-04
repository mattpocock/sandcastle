import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  ExecOptions,
  FinishReport,
  OutputDefinition,
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
import type { GeneralInput } from "@ai-hero/sandcastle/v1/tasks";
import { general } from "@ai-hero/sandcastle/v1/tasks";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import { bareRepo, spied, stubClaude } from "./helpers/taskWorld.js";

// Bundled tasks through `/v1/tasks`, on the fake sandbox with a local bare git
// repo standing in for GitHub. The task's agent is the real `claudeCode`, so
// a stub `claude` on the sandbox's PATH stands in for the CLI: it records the
// env, real working directory and prompt it was run with, then prints a recorded
// stream. The fake sandbox needs `sh` and POSIX process groups, and the
// supervisor bundle comes from the build, so these skip on Windows.

const RECORDED = path.resolve(
  import.meta.dirname,
  "../src/__fixtures__/context-window/claude-code.stream.jsonl",
);

const TOKEN = "ghs_tasktesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const VERDICT = Output.object({
  tag: "verdict",
  schema: z.object({ ok: z.boolean() }),
});

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

/** A recorded Claude Code run that ends with the final message `DONE`. */
const recorded = async (): Promise<string[]> => {
  const text = await readFile(RECORDED, "utf8");
  return text.trim().split("\n");
};

/** Starts `general` and waits for its session's result. */
const finished = async <const O extends OutputDefinition | undefined>(
  sandbox: Sandbox,
  input: GeneralInput<O>,
) => {
  const spawned = await general.start(sandbox, input);
  return spawned.wait();
};

/** The report's work, which must have succeeded. */
const succeeded = <O extends OutputMap>(
  report: FinishReport<O>,
): SucceededDetachedWork<O> => {
  if (report.data.status !== "succeeded") {
    throw new Error(`the work failed: ${report.data.failure.message}`);
  }
  return report.data;
};

describe.skipIf(process.platform === "win32")("bundled tasks (v1)", () => {
  let rootDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();
  let origin = "";
  let receivers: FinishReportReceiver[] = [];

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-tasks-"));
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

  it("exports general with start, outputs and limits", () => {
    expect(general.start).toBeTypeOf("function");
    expect(general.outputs).toBeTypeOf("function");
    expect(general.limits).toStrictEqual({
      timeLimitMinutes: 40,
      deadlineMinutes: 30,
    });
  });

  it("requires skillsContext.tracker", async () => {
    const sandbox = await createSandbox({ provider });
    await expect(
      // @ts-expect-error: every bundled task needs the tracker.
      general.start(sandbox, { prompt: "Hi.", skillsContext: {} }),
    ).rejects.toThrow(TypeError);
  });

  it("clones the repo, runs setup in the clone, then starts one session named general there", async () => {
    const claude = await stubClaude(
      path.join(rootDir, "agent"),
      await recorded(),
    );
    await using sandbox = await createSandbox({
      provider,
      env: claude.env,
      timeLimitMinutes: general.limits.timeLimitMinutes,
    });

    const spawned = await general.start(sandbox, {
      prompt: "Read the notes, then say DONE.",
      repo: origin,
      skillsContext: GITHUB,
      setup: ["touch ran-setup"],
    });
    const done = await spawned.wait();

    expect(spawned.name).toBe("general");
    expect(done.finalMessage).toBe("DONE");
    await expect(
      readFile(workOf(sandbox, "widgets", "README.md"), "utf8"),
    ).resolves.toBe("# Widgets\n");
    await expect(
      readFile(workOf(sandbox, "widgets", "ran-setup"), "utf8"),
    ).resolves.toBe("");
    await expect(claude.read("agent-cwd.txt")).resolves.toBe(
      `${await realpath(workOf(sandbox, "widgets"))}\n`,
    );
    await expect(claude.read("agent-argv.txt")).resolves.toContain(
      "--model sonnet",
    );
  });

  it("runs in the working directory with no repo, and rejects when a setup command fails", async () => {
    const claude = await stubClaude(path.join(rootDir, "agent"), [
      init("s-norepo"),
      result("ok"),
    ]);
    await using sandbox = await createSandbox({ provider, env: claude.env });

    const done = await finished(sandbox, {
      prompt: "Say ok.",
      skillsContext: GITHUB,
    });

    expect(done.finalMessage).toBe("ok");
    await expect(claude.read("agent-cwd.txt")).resolves.toBe(
      `${await realpath(workOf(sandbox))}\n`,
    );
    await expect(
      general.start(sandbox, {
        prompt: "Say ok.",
        skillsContext: GITHUB,
        setup: ["exit 3"],
      }),
    ).rejects.toThrow(/exit 3/u);
  });

  it("puts the GitHub token only in the clone command's env and the session's env", async () => {
    const agentDir = path.join(rootDir, "agent");
    const claude = await stubClaude(agentDir, [init("s-token"), result("ok")]);
    const sandbox = await createSandbox({ provider, env: claude.env });
    const calls: ExecOptions[] = [];

    await finished(spied(sandbox, calls), {
      prompt: "Say ok.",
      repo: origin,
      githubToken: TOKEN,
      skillsContext: GITHUB,
      setup: [`env > "${agentDir}/setup-env.txt"`],
    });

    const withToken = calls
      .filter((call) => call.env?.GH_TOKEN === TOKEN)
      .map((call) => call.command);
    expect(withToken).toHaveLength(1);
    expect(withToken[0]).toContain(" clone ");
    expect(calls.map((call) => call.command).join("\n")).not.toContain(TOKEN);
    await expect(claude.read("agent-env.txt")).resolves.toContain(
      `GH_TOKEN=${TOKEN}`,
    );
    await expect(claude.read("setup-env.txt")).resolves.not.toContain(TOKEN);
    await expect(
      readFile(workOf(sandbox, "widgets", ".git", "config"), "utf8"),
    ).resolves.not.toContain(TOKEN);
  });

  it("asks for the output tag, gives the tracker instructions and says no human is watching", async () => {
    const claude = await stubClaude(path.join(rootDir, "agent"), [
      init("s-prompt"),
      result('<verdict>{"ok": true}</verdict>'),
    ]);
    await using sandbox = await createSandbox({ provider, env: claude.env });

    const done = await finished(sandbox, {
      prompt: "Is the build green?",
      skillsContext: {
        tracker: {
          kind: "custom",
          name: "Linear",
          instructions: "Read a ticket with `linear issue view <id>`.",
        },
      },
      output: VERDICT,
    });
    const prompt = await claude.read("agent-prompt.txt");

    const ok: boolean = done.output.ok;
    expect(ok).toBe(true);
    expect(prompt.startsWith("Is the build green?")).toBe(true);
    expect(prompt).toContain("<verdict>");
    expect(prompt).toContain(
      "# Issue tracker: Linear\n\nRead a ticket with `linear issue view <id>`.",
    );
    expect(prompt).toContain("CLAUDE.md or AGENTS.md");
    expect(prompt).toContain("No human is watching");
    expect(prompt).toContain("`blocked`");
  });

  it("renders the GitHub tracker instructions into the prompt", async () => {
    const claude = await stubClaude(path.join(rootDir, "agent"), [
      init("s-github"),
      result("ok"),
    ]);
    await using sandbox = await createSandbox({ provider, env: claude.env });

    await finished(sandbox, { prompt: "Hi.", skillsContext: GITHUB });

    await expect(claude.read("agent-prompt.txt")).resolves.toContain(
      "# Issue tracker: GitHub",
    );
  });

  describe("the detach deadline", () => {
    const waiting = async () =>
      stubClaude(path.join(rootDir, "agent"), [init("s-wait"), result("ok")], {
        waitForGo: true,
      });

    it("defaults to the task's deadline, counted from start", async () => {
      const claude = await waiting();
      const sandbox = await createSandbox({
        provider,
        env: claude.env,
        timeLimitMinutes: general.limits.timeLimitMinutes,
      });
      const before = Date.now();

      await general.start(sandbox, { prompt: "Hi.", skillsContext: GITHUB });
      const receipt = await sandbox.detach();

      const minutes = 60_000 * general.limits.deadlineMinutes;
      expect(receipt.deadline.getTime()).toBeGreaterThanOrEqual(
        before + minutes,
      );
      expect(receipt.deadline.getTime()).toBeLessThanOrEqual(
        Date.now() + minutes,
      );
    });

    it("lets an explicit deadlineMinutes on detach() win", async () => {
      const claude = await waiting();
      const sandbox = await createSandbox({
        provider,
        env: claude.env,
        timeLimitMinutes: general.limits.timeLimitMinutes,
      });
      await general.start(sandbox, { prompt: "Hi.", skillsContext: GITHUB });
      const before = Date.now();

      const receipt = await sandbox.detach({ deadlineMinutes: 34 });

      expect(receipt.deadline.getTime()).toBeGreaterThanOrEqual(
        before + 34 * 60_000,
      );
      expect(receipt.deadline.getTime()).toBeLessThanOrEqual(
        Date.now() + 34 * 60_000,
      );
    });

    it("rejects start when the kill time leaves less room than the task needs", async () => {
      const claude = await waiting();
      await using sandbox = await createSandbox({
        provider,
        env: claude.env,
        timeLimitMinutes: 10,
      });

      await expect(
        general.start(sandbox, {
          prompt: "Hi.",
          repo: origin,
          skillsContext: GITHUB,
        }),
      ).rejects.toThrow(RangeError);
      await expect(
        readFile(workOf(sandbox, "widgets", "README.md"), "utf8"),
      ).rejects.toThrow(/ENOENT/u);
    });
  });

  describe("general.outputs", () => {
    const detachedReport = async (
      lines: readonly string[],
      output?: typeof VERDICT,
    ) => {
      const claude = await stubClaude(path.join(rootDir, "agent"), lines, {
        waitForGo: true,
      });
      const hook = await finishReportReceiver();
      receivers.push(hook);
      const secret = "whsec_dGFza3MtdGVzdC1zZWNyZXQtMDEyMzQ1Njc4OQ==";
      const sandbox = await createSandbox({
        provider,
        env: claude.env,
        timeLimitMinutes: general.limits.timeLimitMinutes,
      });
      await general.start(sandbox, {
        prompt: "Is the build green?",
        skillsContext: GITHUB,
        ...(output === undefined ? {} : { output }),
      });
      await sandbox.detach({ finishReport: { url: hook.url, secret } });
      await claude.go();
      const delivery = await hook.first();
      return { body: delivery.body, headers: delivery.headers, secret };
    };

    it("validates a recorded run's finish report with the final message only", async () => {
      const delivered = await detachedReport(await recorded());

      const report = await verifyFinishReport({
        ...delivered,
        outputs: general.outputs(),
      });

      expect(succeeded(report).sessions.general?.finalMessage).toBe("DONE");
    });

    it("validates and types the caller's Output", async () => {
      const delivered = await detachedReport(
        [init("s-verdict"), result('<verdict>{"ok": true}</verdict>')],
        VERDICT,
      );

      const report = await verifyFinishReport({
        ...delivered,
        outputs: general.outputs(VERDICT),
      });

      const ok: boolean = succeeded(report).sessions.general.output.ok;
      expect(ok).toBe(true);
    });
  });
});
