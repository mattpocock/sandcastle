import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "../AgentProvider.js";
import type { SkillSpec } from "../AgentSkills.js";
import type { RunOptions, RunResult } from "../run.js";
import type { SandboxProvider } from "../SandboxProvider.js";
import { WorkflowValidationError } from "./errors.js";
import { runWorkflow } from "./WorkflowManager.js";
import {
  type WorkflowAgentRunFunction,
  WORKFLOW_AGENT_OUTPUT_TAG,
} from "./WorkflowAgentRunner.js";

const testAgent = (name = "test-agent"): AgentProvider => ({
  name,
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({ command: "agent" }),
  parseStreamLine: () => [],
});

const testSandbox = (name = "test-sandbox"): SandboxProvider =>
  ({
    tag: "none",
    name,
    env: {},
    create: async () => {
      throw new Error("test sandbox should not be created");
    },
  }) as SandboxProvider;

const runResult = (
  options: RunOptions,
  overrides: Partial<RunResult> = {},
): RunResult => ({
  iterations: [],
  stdout: "agent output",
  commits: [],
  branch:
    options.branchStrategy?.type === "branch"
      ? options.branchStrategy.branch
      : "unexpected-head",
  ...overrides,
});

const fakeAgentRun = (
  implementation?: (options: RunOptions) => Promise<RunResult> | RunResult,
): WorkflowAgentRunFunction =>
  vi.fn(async (options: RunOptions) =>
    implementation === undefined ? runResult(options) : implementation(options),
  ) as unknown as WorkflowAgentRunFunction;

const readJson = async <Value = unknown>(path: string): Promise<Value> =>
  JSON.parse(await readFile(path, "utf8")) as Value;

const workflowSource = (runBody: string, defaults = ""): string => `
  export default {
    meta: { name: "manager-test", description: "Workflow manager test" },
    ${defaults}
    async run(ctx) {
      ${runBody}
    },
  };
`;

async function withTempDir<T>(test: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-workflow-manager-"));
  try {
    return await test(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runWorkflow", () => {
  it("runs a simple workflow source and persists source, state, result, and events", async () => {
    await withTempDir(async (cwd) => {
      const source = workflowSource(
        "return { ok: true, cwd: ctx.workflow.cwd };",
      );

      const result = await runWorkflow({
        cwd,
        source,
        runId: "simple-run",
        runsRoot: "runs",
      });

      expect(result).toMatchObject({
        runId: "simple-run",
        status: "succeeded",
        result: { ok: true, cwd },
        runDir: join(cwd, "runs", "simple-run"),
      });
      await expect(access(result.runDir)).resolves.toBeUndefined();
      await expect(
        readFile(join(result.runDir, "workflow.ts"), "utf8"),
      ).resolves.toBe(source);
      await expect(
        readJson(join(result.runDir, "result.json")),
      ).resolves.toEqual({
        ok: true,
        cwd,
      });
      await expect(
        readJson(join(result.runDir, "state.json")),
      ).resolves.toMatchObject({
        id: "simple-run",
        status: "succeeded",
        result: { ok: true, cwd },
        agentCount: 0,
        maxAgents: 50,
        concurrency: 4,
        finishedAt: expect.any(String),
      });
      expect(
        await readFile(join(result.runDir, "events.jsonl"), "utf8"),
      ).toContain('"type":"workflow_succeeded"');
    });
  });

  it("passes args into ctx and returns the workflow result", async () => {
    await withTempDir(async (cwd) => {
      const result = await runWorkflow({
        cwd,
        source: workflowSource(
          "return { greeting: `hello ${ctx.args.name}`, count: ctx.args.items.length };",
        ),
        args: { name: "Sandcastle", items: [1, 2, 3] },
        runId: "args-run",
        runsRoot: "runs",
      });

      expect(result.status).toBe("succeeded");
      expect(result.result).toEqual({
        greeting: "hello Sandcastle",
        count: 3,
      });
    });
  });

  it("runs ctx.agent with a fake agent run and persists journal and artifacts", async () => {
    await withTempDir(async (cwd) => {
      const run = fakeAgentRun((options) =>
        runResult(options, {
          stdout: `<${WORKFLOW_AGENT_OUTPUT_TAG}>{"answer":42}</${WORKFLOW_AGENT_OUTPUT_TAG}>`,
          commits: [{ sha: "abc123" }],
          iterations: [
            {
              sessionId: "session-1",
              usage: {
                inputTokens: 1,
                cacheCreationInputTokens: 2,
                cacheReadInputTokens: 3,
                outputTokens: 7,
              },
            },
          ],
        }),
      );

      const result = await runWorkflow({
        cwd,
        source: workflowSource(`
          await ctx.phase("Build");
          const agentResult = await ctx.agent("Return the answer", {
            label: "Answer Agent",
            schema: {
              type: "object",
              required: ["answer"],
              properties: { answer: { type: "integer" } },
            },
          });
          return {
            output: agentResult.output,
            branch: agentResult.branch,
            artifactNames: agentResult.artifacts.map((artifact) => artifact.name),
          };
        `),
        runId: "agent-run",
        runsRoot: "runs",
        defaultAgent: testAgent(),
        defaultSandbox: testSandbox(),
        agentRun: run,
      });

      expect(result).toMatchObject({
        status: "succeeded",
        result: {
          output: { answer: 42 },
          branch: "sandcastle/workflow/agent-run/001-answer-agent",
          artifactNames: ["prompt", "stdout", "result", "run"],
        },
      });
      expect(vi.mocked(run)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(run).mock.calls[0]?.[0].prompt).toContain(
        "Return the answer",
      );
      expect(
        await readJson(
          join(result.runDir, "agents", "001-answer-agent", "result.json"),
        ),
      ).toEqual({
        answer: 42,
      });
      expect(
        await readJson(
          join(result.runDir, "agents", "001-answer-agent", "run.json"),
        ),
      ).toMatchObject({
        branch: "sandcastle/workflow/agent-run/001-answer-agent",
        commits: [{ sha: "abc123" }],
        sessionId: "session-1",
        usage: {
          inputTokens: 1,
          cacheCreationInputTokens: 2,
          cacheReadInputTokens: 3,
          outputTokens: 7,
        },
      });
      const journal = await readFile(
        join(result.runDir, "journal.jsonl"),
        "utf8",
      );
      expect(journal).toContain('"callId":"001-answer-agent"');
      expect(journal).toContain('"phase":"Build"');
      expect(journal).toContain('"status":"succeeded"');
    });
  });

  it("resumes a workflow run by replaying matching successful agent journal entries", async () => {
    await withTempDir(async (cwd) => {
      const run = fakeAgentRun((options) =>
        runResult(options, {
          stdout: "stored output",
          commits: [{ sha: "abc123" }],
        }),
      );
      const source = workflowSource(`
        const agentResult = await ctx.agent("Return the same answer", {
          label: "Answer Agent",
        });
        return {
          output: agentResult.output,
          status: agentResult.status,
          branch: agentResult.branch,
        };
      `);

      await runWorkflow({
        cwd,
        source,
        runId: "first-run",
        runsRoot: "runs",
        defaultAgent: testAgent(),
        defaultSandbox: testSandbox(),
        agentRun: run,
      });
      const result = await runWorkflow({
        cwd,
        source,
        runId: "second-run",
        runsRoot: "runs",
        resume: { fromRunId: "first-run" },
        defaultAgent: testAgent(),
        defaultSandbox: testSandbox(),
        agentRun: run,
      });

      expect(run).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        status: "succeeded",
        result: {
          output: "stored output",
          status: "skipped",
          branch: "sandcastle/workflow/first-run/001-answer-agent",
        },
      });
      expect(
        await readJson(
          join(result.runDir, "agents", "001-answer-agent", "result.json"),
        ),
      ).toMatchObject({
        status: "skipped",
        reason: "replayed",
        replayedFrom: {
          runId: "first-run",
          callId: "001-answer-agent",
        },
        output: "stored output",
      });
      const events = await readFile(
        join(result.runDir, "events.jsonl"),
        "utf8",
      );
      expect(events).toContain('"type":"agent_replayed"');
    });
  });

  it("resolves workflow defaults for provider, model, sandbox, and skills", async () => {
    await withTempDir(async (cwd) => {
      const run = fakeAgentRun();
      const tddSkill: SkillSpec = { name: "tdd", source: "./skills/tdd" };
      const docsSkill: SkillSpec = { name: "docs", source: "./skills/docs" };
      const resolveAgentProvider = vi.fn(({ provider, model }) =>
        testAgent(`${provider}:${model}`),
      );
      const resolveSandbox = vi.fn(({ sandbox }) => testSandbox(sandbox));

      const result = await runWorkflow({
        cwd,
        source: workflowSource(
          `
          const agentResult = await ctx.agent("Use defaults", {
            label: "Defaulted Agent",
          });
          return {
            status: agentResult.status,
            branch: agentResult.branch,
          };
        `,
          `
          defaults: {
            provider: "claude-code",
            model: "claude-opus-4-8",
            sandbox: "podman",
            skills: ["tdd"],
          },
        `,
        ),
        runId: "default-resolution-run",
        runsRoot: "runs",
        skills: [tddSkill, docsSkill],
        resolveAgentProvider,
        resolveSandbox,
        agentRun: run,
      });

      expect(result.status).toBe("succeeded");
      expect(resolveAgentProvider).toHaveBeenCalledWith({
        provider: "claude-code",
        model: "claude-opus-4-8",
        cwd,
        runId: "default-resolution-run",
      });
      expect(resolveSandbox).toHaveBeenCalledWith({
        sandbox: "podman",
        cwd,
        runId: "default-resolution-run",
      });
      expect(vi.mocked(run).mock.calls[0]?.[0]).toMatchObject({
        agent: { name: "claude-code:claude-opus-4-8" },
        sandbox: { name: "podman" },
        skills: [tddSkill],
      });
    });
  });

  it("lets host run options override workflow defaults", async () => {
    await withTempDir(async (cwd) => {
      const run = fakeAgentRun();
      const tddSkill: SkillSpec = { name: "tdd", source: "./skills/tdd" };
      const docsSkill: SkillSpec = { name: "docs", source: "./skills/docs" };

      const result = await runWorkflow({
        cwd,
        source: workflowSource(
          `
          const agentResult = await ctx.agent("Use host overrides", {
            label: "Overridden Agent",
          });
          return agentResult.status;
        `,
          `
          defaults: {
            provider: "claude-code",
            model: "claude-opus-4-8",
            sandbox: "podman",
            skills: ["tdd"],
          },
        `,
        ),
        runId: "host-override-run",
        runsRoot: "runs",
        provider: "codex",
        model: "gpt-5.5",
        sandbox: "no-sandbox",
        defaultSkillNames: ["docs"],
        skills: [tddSkill, docsSkill],
        resolveAgentProvider: ({ provider, model }) =>
          testAgent(`${provider}:${model}`),
        resolveSandbox: ({ sandbox }) => testSandbox(sandbox),
        agentRun: run,
      });

      expect(result).toMatchObject({
        status: "succeeded",
        result: "succeeded",
      });
      expect(vi.mocked(run).mock.calls[0]?.[0]).toMatchObject({
        agent: { name: "codex:gpt-5.5" },
        sandbox: { name: "no-sandbox" },
        skills: [docsSkill],
      });
    });
  });

  it("records final failed state, error, and events when an agent run fails", async () => {
    await withTempDir(async (cwd) => {
      const run = fakeAgentRun(() => {
        throw new Error("agent exploded");
      });

      const result = await runWorkflow({
        cwd,
        source: workflowSource(`
          const agentResult = await ctx.agent("Break", { label: "Breaker" });
          if (agentResult.status === "failed") {
            throw new Error(agentResult.error.message);
          }
          return "unreachable";
        `),
        runId: "agent-failure-run",
        runsRoot: "runs",
        defaultAgent: testAgent(),
        defaultSandbox: testSandbox(),
        agentRun: run,
      });

      expect(result.status).toBe("failed");
      expect(result.error).toMatchObject({
        name: "Error",
        message: "agent exploded",
      });
      await expect(
        readJson(join(result.runDir, "state.json")),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          name: "Error",
          message: "agent exploded",
        },
        agentCount: 1,
      });
      const events = await readFile(
        join(result.runDir, "events.jsonl"),
        "utf8",
      );
      expect(events).toContain('"type":"agent_failed"');
      expect(events).toContain('"type":"workflow_failed"');
      expect(
        await readFile(join(result.runDir, "journal.jsonl"), "utf8"),
      ).toContain('"status":"failed"');
    });
  });

  it("treats a workflow returning undefined as a successful void result", async () => {
    await withTempDir(async (cwd) => {
      const result = await runWorkflow({
        cwd,
        source: workflowSource("ctx.log.info('done');"),
        runId: "void-run",
        runsRoot: "runs",
      });

      expect(result.status).toBe("succeeded");
      expect(result).not.toHaveProperty("result");
      await expect(
        access(join(result.runDir, "result.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readJson(join(result.runDir, "state.json")),
      ).resolves.toMatchObject({
        status: "succeeded",
      });
      expect(
        await readJson(join(result.runDir, "state.json")),
      ).not.toHaveProperty("result");
      expect(
        await readFile(join(result.runDir, "events.jsonl"), "utf8"),
      ).toContain('"type":"workflow_succeeded"');
    });
  });

  it("writes error, emits workflow_failed, and records failed state on script failure", async () => {
    await withTempDir(async (cwd) => {
      const result = await runWorkflow({
        cwd,
        source: workflowSource('throw new Error("script exploded");'),
        runId: "failed-run",
        runsRoot: "runs",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toMatchObject({
        name: "Error",
        message: "script exploded",
      });
      await expect(
        readFile(join(result.runDir, "error.txt"), "utf8"),
      ).resolves.toContain("script exploded");
      await expect(
        readJson(join(result.runDir, "state.json")),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          name: "Error",
          message: "script exploded",
        },
        finishedAt: expect.any(String),
      });
      expect(
        await readFile(join(result.runDir, "events.jsonl"), "utf8"),
      ).toContain('"type":"workflow_failed"');
    });
  });

  it("throws predictably for validation failures and does not create a run", async () => {
    await withTempDir(async (cwd) => {
      await expect(
        runWorkflow({
          cwd,
          source: `
            export default {
              meta: { name: "" },
              run() {
                return "nope";
              },
            };
          `,
          runId: "invalid-run",
          runsRoot: "runs",
        }),
      ).rejects.toMatchObject({
        name: "WorkflowValidationError",
        message: "Workflow source validation failed.",
        details: {
          errors: [
            expect.objectContaining({
              code: "workflow_shape_invalid",
              message:
                "Workflow definition meta.name must be a non-empty string.",
            }),
          ],
        },
      } satisfies Partial<WorkflowValidationError>);

      await expect(access(join(cwd, "runs"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("respects maxAgents for agent-using workflows", async () => {
    await withTempDir(async (cwd) => {
      const run = fakeAgentRun();

      const result = await runWorkflow({
        cwd,
        source: workflowSource(`
          await ctx.agent("first", { label: "First" });
          await ctx.agent("second", { label: "Second" });
          return "unreachable";
        `),
        runId: "agent-limit-run",
        runsRoot: "runs",
        maxAgents: 1,
        defaultAgent: testAgent(),
        defaultSandbox: testSandbox(),
        agentRun: run,
      });

      expect(result.status).toBe("failed");
      expect(result.error).toMatchObject({
        name: "WorkflowAgentLimitError",
      });
      expect(vi.mocked(run)).toHaveBeenCalledTimes(1);
      await expect(
        readJson(join(result.runDir, "state.json")),
      ).resolves.toMatchObject({
        status: "failed",
        agentCount: 1,
        maxAgents: 1,
      });
    });
  });

  it("returns the requested runId and runDir", async () => {
    await withTempDir(async (cwd) => {
      const result = await runWorkflow({
        cwd,
        source: workflowSource('return "ok";'),
        runId: "custom-run-id",
        runsRoot: "workflow-runs",
      });

      expect(result.runId).toBe("custom-run-id");
      expect(result.runDir).toBe(join(cwd, "workflow-runs", "custom-run-id"));
      await expect(access(result.runDir)).resolves.toBeUndefined();
    });
  });
});
