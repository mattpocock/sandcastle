import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentProvider, Sandbox } from "@ai-hero/sandcastle/v1";
import { claudeCode, createSandbox, Output } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeAgent, fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type { TaskAgentOptions } from "@ai-hero/sandcastle/v1/tasks";
import { general, implement, review } from "@ai-hero/sandcastle/v1/tasks";
import {
  bareRepo,
  pullRequest,
  stubClaude,
  stubGh,
} from "./helpers/taskWorld.js";

// Every bundled task with the caller's own agent: `fakeAgent` from
// `/v1/testing` in place of the real CLI, or a built-in agent other than the
// task's default. A local bare repo stands in for GitHub, with a pull request
// for `review` and a stub `gh` that answers `gh pr view`; a stub `claude`
// records how it was run, so a test can tell whether the real CLI ran. POSIX
// only, like the other task tests.

const TOKEN = "ghs_agenttesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const PR = { number: 7, branch: "add-gadgets", file: "GADGETS.md" } as const;

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const IMPLEMENTED = `Opened the PR.\n<implementResult>${JSON.stringify({
  status: "pr-opened",
  branch: "sandcastle/implement-42",
  pr: { number: 7, url: "https://github.com/o/widgets/pull/7" },
  summary: "Added the widget.",
})}</implementResult>`;

const REVIEWED = `Posted.\n<reviewResult>${JSON.stringify({
  verdict: "approve",
  comments: [],
  summary: "Standards: 0 findings. Spec: 0 findings.",
})}</reviewResult>`;

/** Each bundled task, started on `origin` with the caller's agent options, and its final message. */
interface TaskCase {
  readonly name: "general" | "implement" | "review";
  readonly timeLimitMinutes: number;
  readonly finalMessage: string;
  readonly start: (
    sandbox: Sandbox,
    origin: string,
    options: TaskAgentOptions,
  ) => Promise<{ readonly wait: () => Promise<unknown> }>;
  /** What the session's output must hold, from `finalMessage`. */
  readonly output: unknown;
}

const VERDICT_MESSAGE = 'Done.\n<verdict>{"ok":true}</verdict>';

const CASES: readonly TaskCase[] = [
  {
    name: "general",
    timeLimitMinutes: general.limits.timeLimitMinutes,
    finalMessage: "Read it. DONE",
    start: async (sandbox, origin, options) =>
      general.start(sandbox, {
        prompt: "Read the README, then say DONE.",
        repo: origin,
        githubToken: TOKEN,
        skillsContext: GITHUB,
        ...options,
      }),
    output: undefined,
  },
  {
    name: "implement",
    timeLimitMinutes: implement.limits.timeLimitMinutes,
    finalMessage: IMPLEMENTED,
    start: async (sandbox, origin, options) =>
      implement.start(sandbox, {
        repo: origin,
        ticket: "42",
        githubToken: TOKEN,
        skillsContext: GITHUB,
        ...options,
      }),
    output: expect.objectContaining({ status: "pr-opened" }),
  },
  {
    name: "review",
    timeLimitMinutes: review.limits.timeLimitMinutes,
    finalMessage: REVIEWED,
    start: async (sandbox, origin, options) =>
      review.start(sandbox, {
        repo: origin,
        pr: PR.number,
        githubToken: TOKEN,
        skillsContext: GITHUB,
        ...options,
      }),
    output: expect.objectContaining({ verdict: "approve" }),
  },
];

describe.skipIf(process.platform === "win32")(
  "bundled tasks with the caller's agent (v1)",
  () => {
    let rootDir = "";
    let agentDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let origin = "";

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-agents-"));
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

    /** A sandbox with a stub `claude` printing `lines` and a stub `gh` on its PATH. */
    const world = async (
      timeLimitMinutes: number,
      lines: readonly string[],
    ) => {
      const claude = await stubClaude(agentDir, lines);
      await stubGh(agentDir, {
        baseRefName: "main",
        headRefName: PR.branch,
        closingIssuesReferences: [],
      });
      const sandbox = await createSandbox({
        provider,
        env: claude.env,
        timeLimitMinutes,
      });
      return { claude, sandbox };
    };

    it.each(CASES)(
      "$name: fakeAgent runs the session in place of the real CLI",
      async (task) => {
        const { claude, sandbox } = await world(task.timeLimitMinutes, [
          init("s-real"),
          result("the real CLI ran"),
        ]);

        const spawned = await task.start(sandbox, origin, {
          agent: fakeAgent({
            lines: [init(`s-fake-${task.name}`), result(task.finalMessage)],
          }),
        });
        const done = await spawned.wait();

        expect(done).toMatchObject({
          agent: "claude-code",
          sessionId: `s-fake-${task.name}`,
          finalMessage: task.finalMessage,
          output: task.output,
        });
        await expect(claude.read("agent-argv.txt")).rejects.toThrow(/ENOENT/u);
      },
    );

    it.each(CASES)(
      "$name: a non-default agent runs with its own model and env, beside the task's GH_TOKEN",
      async (task) => {
        const { claude, sandbox } = await world(task.timeLimitMinutes, [
          init(`s-haiku-${task.name}`),
          result(task.finalMessage),
        ]);

        const spawned = await task.start(sandbox, origin, {
          agent: claudeCode("haiku", {
            env: { AGENT_ONLY: "from-the-agent" },
          }),
        });
        const done = await spawned.wait();

        expect(done).toMatchObject({ output: task.output });
        await expect(claude.read("agent-argv.txt")).resolves.toContain(
          "--model haiku",
        );
        const env = await claude.read("agent-env.txt");
        expect(env).toContain("AGENT_ONLY=from-the-agent");
        expect(env).toContain(`GH_TOKEN=${TOKEN}`);
      },
    );

    it.each(CASES.filter((task) => task.name !== "general"))(
      "$name: completionTimeoutSeconds stops an agent that hangs after its closing tag",
      async (task) => {
        const { sandbox } = await world(task.timeLimitMinutes, []);

        const spawned = await task.start(sandbox, origin, {
          agent: fakeAgent({
            lines: [init(`s-hang-${task.name}`), result(task.finalMessage)],
            hang: true,
          }),
          completionTimeoutSeconds: 0.2,
        });
        const done = await spawned.wait();

        expect(done).toMatchObject({
          exitReason: "closing-tag",
          output: task.output,
        });
      },
    );

    it("general: completionTimeoutSeconds stops an agent that hangs after the caller's output tag", async () => {
      const { sandbox } = await world(general.limits.timeLimitMinutes, []);

      const spawned = await general.start(sandbox, {
        prompt: "Is the build green?",
        skillsContext: GITHUB,
        output: Output.object({
          tag: "verdict",
          schema: z.object({ ok: z.boolean() }),
        }),
        agent: fakeAgent({
          lines: [init("s-hang-general"), result(VERDICT_MESSAGE)],
          hang: true,
        }),
        completionTimeoutSeconds: 0.2,
      });
      const done = await spawned.wait();

      expect(done.exitReason).toBe("closing-tag");
      expect(done.output.ok).toBe(true);
    });

    it.each(CASES)(
      "$name: rejects a custom agent or a non-positive completionTimeoutSeconds before cloning",
      async (task) => {
        const { sandbox } = await world(task.timeLimitMinutes, []);
        const custom: AgentProvider = {
          name: "claude-code",
          model: "mine",
          acceptsInput: true,
        };

        await expect(
          task.start(sandbox, origin, { agent: custom }),
        ).rejects.toThrow(/built-in agent factory/u);
        await expect(
          task.start(sandbox, origin, { completionTimeoutSeconds: 0 }),
        ).rejects.toThrow(/completionTimeoutSeconds/u);
        await expect(
          readFile(workOf(sandbox, "widgets", "README.md"), "utf8"),
        ).rejects.toThrow(/ENOENT/u);
      },
    );
  },
);
