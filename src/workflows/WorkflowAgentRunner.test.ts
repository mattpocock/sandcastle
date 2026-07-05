import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "../AgentProvider.js";
import type { SkillSpec } from "../AgentSkills.js";
import type { RunOptions, RunResult } from "../run.js";
import type { SandboxProvider } from "../SandboxProvider.js";
import { WorkflowValidationError } from "./errors.js";
import {
  WORKFLOW_AGENT_OUTPUT_TAG,
  WorkflowAgentRunner,
  type WorkflowAgentRunFunction,
} from "./WorkflowAgentRunner.js";
import { WorkflowRunStore } from "./WorkflowRunStore.js";

const agent = (name: string): AgentProvider =>
  ({
    name,
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({ command: "agent" }),
    parseStreamLine: () => [],
  }) satisfies AgentProvider;

const sandbox = (name: string): SandboxProvider =>
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
  overrides: Partial<RunResult & { output?: unknown }> = {},
): RunResult & { output?: unknown } => ({
  iterations: [],
  stdout: "agent stdout",
  commits: [],
  branch:
    options.branchStrategy?.type === "branch"
      ? options.branchStrategy.branch
      : "unexpected-head",
  ...overrides,
});

const fakeRun = (
  implementation?: (
    options: RunOptions,
  ) => Promise<RunResult & { output?: unknown }>,
): WorkflowAgentRunFunction =>
  vi.fn(async (options: RunOptions) => {
    return implementation === undefined
      ? runResult(options)
      : implementation(options);
  }) as unknown as WorkflowAgentRunFunction;

describe("WorkflowAgentRunner", () => {
  it("passes cwd, providers, skills, branch strategy, prompt, completionSignal, and signal to run", async () => {
    const controller = new AbortController();
    const defaultAgent = agent("default-agent");
    const overrideAgent = agent("override-agent");
    const defaultSandbox = sandbox("default-sandbox");
    const overrideSandbox = sandbox("override-sandbox");
    const tddSkill: SkillSpec = { name: "tdd", source: "./skills/tdd" };
    const docsSkill: SkillSpec = { name: "docs", source: "./skills/docs" };
    const run = fakeRun(async (options) =>
      runResult(options, {
        stdout: `<${WORKFLOW_AGENT_OUTPUT_TAG}>{"answer":42}</${WORKFLOW_AGENT_OUTPUT_TAG}>`,
      }),
    );
    const runner = new WorkflowAgentRunner({
      cwd: "/repo",
      runId: "run-1",
      branchPrefix: "sandcastle/workflows",
      defaultAgent,
      defaultSandbox,
      skills: [tddSkill, docsSkill],
      getPhase: () => "Build",
      signal: controller.signal,
      run,
    });

    const result = await runner.run("Implement the task", {
      label: "Implement Task",
      agent: overrideAgent,
      sandbox: overrideSandbox,
      skills: ["tdd"],
      completionSignal: ["DONE"],
      schema: {
        type: "object",
        required: ["answer"],
        properties: { answer: { type: "integer" } },
      },
    });

    const call = vi.mocked(run).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).toMatchObject({
      cwd: "/repo",
      agent: overrideAgent,
      sandbox: overrideSandbox,
      maxIterations: 1,
      name: "Implement Task",
      skills: [tddSkill],
      branchStrategy: {
        type: "branch",
        branch: "sandcastle/workflows/run-1/001-implement-task",
      },
      completionSignal: ["DONE"],
      signal: controller.signal,
    });
    expect(call?.prompt).toContain("Run ID: run-1");
    expect(call?.prompt).toContain("Agent call ID: 001-implement-task");
    expect(call?.prompt).toContain("Phase: Build");
    expect(call?.prompt).toContain("Label: Implement Task");
    expect(call?.prompt).toContain("Implement the task");
    expect(call?.prompt).toContain(`<${WORKFLOW_AGENT_OUTPUT_TAG}>`);
    expect(call?.output).toBeUndefined();
    expect(result).toMatchObject({
      output: { answer: 42 },
      branch: "sandcastle/workflows/run-1/001-implement-task",
      status: "succeeded",
    });
  });

  it("creates deterministic branch names and prompt wrappers", async () => {
    const run = fakeRun();
    const runner = new WorkflowAgentRunner({
      cwd: "/repo",
      runId: "workflow-run",
      branchPrefix: "/frontier/tasks/",
      defaultAgent: agent("agent"),
      defaultSandbox: sandbox("sandbox"),
      getPhase: () => "Plan",
      run,
    });

    const first = await runner.run("Scout the repo", {
      label: "Readonly Scout!",
      readonly: true,
    });
    const second = await runner.run("Patch the repo", { label: "Patch Repo" });

    expect(first.branch).toBe("frontier/tasks/workflow-run/001-readonly-scout");
    expect(second.branch).toBe("frontier/tasks/workflow-run/002-patch-repo");
    expect(vi.mocked(run).mock.calls[0]?.[0].prompt).toContain(
      "Agent call ID: 001-readonly-scout",
    );
    expect(vi.mocked(run).mock.calls[1]?.[0].prompt).toContain(
      "Agent call ID: 002-patch-repo",
    );
    expect(vi.mocked(run).mock.calls[0]?.[0].branchStrategy).toEqual({
      type: "branch",
      branch: "frontier/tasks/workflow-run/001-readonly-scout",
    });
  });

  it("returns stdout as text output when no schema is provided", async () => {
    const run = fakeRun(async (options) =>
      runResult(options, { stdout: "plain text output" }),
    );
    const runner = new WorkflowAgentRunner({
      cwd: "/repo",
      runId: "run-1",
      branchPrefix: "wf",
      defaultAgent: agent("agent"),
      defaultSandbox: sandbox("sandbox"),
      run,
    });

    const result = await runner.run<string>("Write a summary", {
      label: "Summarize",
    });

    expect(result.output).toBe("plain text output");
    expect(vi.mocked(run).mock.calls[0]?.[0].output).toBeUndefined();
  });

  it("returns structured output when schema is provided", async () => {
    const structured = { title: "Result" };
    const run = fakeRun(async (options) =>
      runResult(options, {
        stdout: `<${WORKFLOW_AGENT_OUTPUT_TAG}>{"title":"Result"}</${WORKFLOW_AGENT_OUTPUT_TAG}>`,
      }),
    );
    const runner = new WorkflowAgentRunner({
      cwd: "/repo",
      runId: "run-1",
      branchPrefix: "wf",
      defaultAgent: agent("agent"),
      defaultSandbox: sandbox("sandbox"),
      run,
    });

    const result = await runner.run<typeof structured>("Return JSON", {
      label: "Structured",
      schema: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
      },
    });

    expect(result.output).toEqual(structured);
    expect(vi.mocked(run).mock.calls[0]?.[0].output).toBeUndefined();
  });

  it("writes prompt/result artifacts and appends journal metadata when a store is supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-agent-runner-"));
    try {
      const store = new WorkflowRunStore({ cwd: dir });
      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-1",
      });
      const run = fakeRun(async (options) =>
        runResult(options, {
          stdout: "stdout text",
          commits: [{ sha: "abc123" }],
          logFilePath: join(dir, ".sandcastle", "logs", "agent.log"),
          iterations: [
            {
              sessionId: "session-1",
              usage: {
                inputTokens: 10,
                cacheCreationInputTokens: 2,
                cacheReadInputTokens: 3,
                outputTokens: 4,
              },
            },
          ],
        }),
      );
      const runner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-1",
        branchPrefix: "wf",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        getPhase: () => "Verify",
        run,
      });

      const result = await runner.run("Persist this call", {
        label: "Persist",
      });
      const journal = await store.readJournal("run-1");

      expect(result).toMatchObject({
        output: "stdout text",
        branch: "wf/run-1/001-persist",
        commits: [{ sha: "abc123" }],
        sessionId: "session-1",
        status: "succeeded",
      });
      expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
        "prompt",
        "stdout",
        "result",
        "run",
        "log",
      ]);
      const promptPath = result.artifacts.find(
        (artifact) => artifact.name === "prompt",
      )?.path;
      const stdoutPath = result.artifacts.find(
        (artifact) => artifact.name === "stdout",
      )?.path;
      const resultPath = result.artifacts.find(
        (artifact) => artifact.name === "result",
      )?.path;
      const runPath = result.artifacts.find(
        (artifact) => artifact.name === "run",
      )?.path;

      expect(promptPath).toBeDefined();
      expect(stdoutPath).toBeDefined();
      expect(resultPath).toBeDefined();
      expect(runPath).toBeDefined();
      expect(await readFile(promptPath!, "utf8")).toContain(
        "Persist this call",
      );
      expect(await readFile(stdoutPath!, "utf8")).toBe("stdout text");
      expect(JSON.parse(await readFile(resultPath!, "utf8"))).toBe(
        "stdout text",
      );
      expect(JSON.parse(await readFile(runPath!, "utf8"))).toMatchObject({
        branch: "wf/run-1/001-persist",
        commits: [{ sha: "abc123" }],
        logFilePath: join(dir, ".sandcastle", "logs", "agent.log"),
        sessionId: "session-1",
        usage: {
          inputTokens: 10,
          cacheCreationInputTokens: 2,
          cacheReadInputTokens: 3,
          outputTokens: 4,
        },
      });
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({
        callId: "001-persist",
        callIndex: 0,
        label: "Persist",
        phase: "Verify",
        status: "succeeded",
        branch: "wf/run-1/001-persist",
        commits: [{ sha: "abc123" }],
        logFilePath: join(dir, ".sandcastle", "logs", "agent.log"),
        sessionId: "session-1",
        usage: {
          inputTokens: 10,
          cacheCreationInputTokens: 2,
          cacheReadInputTokens: 3,
          outputTokens: 4,
        },
        output: "stdout text",
      });
      expect(journal[0]?.callHash).toMatch(/^[a-f0-9]{64}$/);
      expect(journal[0]?.promptHash).toMatch(/^[a-f0-9]{64}$/);
      expect(journal[0]?.startedAt).toEqual(expect.any(String));
      expect(journal[0]?.finishedAt).toEqual(expect.any(String));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("propagates failed runs as failed WorkflowAgentResult and journal error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-agent-runner-"));
    try {
      const store = new WorkflowRunStore({ cwd: dir });
      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-1",
      });
      const error = Object.assign(new Error("agent failed"), {
        branch: "wf/run-1/001-fail",
        commits: [{ sha: "badc0de" }],
        logFilePath: join(dir, ".sandcastle", "logs", "failed-agent.log"),
        sessionId: "session-failed",
        stdout: "failure stdout",
        usage: {
          inputTokens: 20,
          cacheCreationInputTokens: 1,
          cacheReadInputTokens: 2,
          outputTokens: 3,
        },
      });
      const run = fakeRun(async () => {
        throw error;
      });
      const runner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-1",
        branchPrefix: "wf",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        run,
      });

      const result = await runner.run("This will fail", { label: "Fail" });
      const journal = await store.readJournal("run-1");

      expect(result).toMatchObject({
        branch: "wf/run-1/001-fail",
        commits: [{ sha: "badc0de" }],
        sessionId: "session-failed",
        status: "failed",
        error: {
          name: "Error",
          message: "agent failed",
        },
      });
      expect(result).not.toHaveProperty("output");
      expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
        "prompt",
        "stdout",
        "result",
        "run",
        "log",
      ]);
      const stdoutPath = result.artifacts.find(
        (artifact) => artifact.name === "stdout",
      )?.path;
      const resultPath = result.artifacts.find(
        (artifact) => artifact.name === "result",
      )?.path;
      const runPath = result.artifacts.find(
        (artifact) => artifact.name === "run",
      )?.path;

      expect(stdoutPath).toBeDefined();
      expect(resultPath).toBeDefined();
      expect(runPath).toBeDefined();
      expect(await readFile(stdoutPath!, "utf8")).toBe("failure stdout");
      expect(JSON.parse(await readFile(resultPath!, "utf8"))).toMatchObject({
        status: "failed",
        error: {
          name: "Error",
          message: "agent failed",
        },
      });
      expect(JSON.parse(await readFile(runPath!, "utf8"))).toMatchObject({
        branch: "wf/run-1/001-fail",
        commits: [{ sha: "badc0de" }],
        logFilePath: join(dir, ".sandcastle", "logs", "failed-agent.log"),
        sessionId: "session-failed",
        usage: {
          inputTokens: 20,
          cacheCreationInputTokens: 1,
          cacheReadInputTokens: 2,
          outputTokens: 3,
        },
      });
      expect(journal[0]).toMatchObject({
        status: "failed",
        branch: "wf/run-1/001-fail",
        commits: [{ sha: "badc0de" }],
        logFilePath: join(dir, ".sandcastle", "logs", "failed-agent.log"),
        sessionId: "session-failed",
        usage: {
          inputTokens: 20,
          cacheCreationInputTokens: 1,
          cacheReadInputTokens: 2,
          outputTokens: 3,
        },
        error: {
          name: "Error",
          message: "agent failed",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists run metadata when post-run structured output extraction fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-agent-runner-"));
    try {
      const store = new WorkflowRunStore({ cwd: dir });
      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-1",
      });
      const logFilePath = join(
        dir,
        ".sandcastle",
        "logs",
        "structured-agent.log",
      );
      const usage = {
        inputTokens: 30,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 5,
        outputTokens: 6,
      };
      const run = fakeRun(async (options) =>
        runResult(options, {
          stdout: "stdout without the requested tag",
          commits: [{ sha: "f00dbabe" }],
          logFilePath,
          iterations: [
            {
              sessionId: "session-structured",
              sessionFilePath: join(dir, "session.jsonl"),
              usage,
            },
          ],
        }),
      );
      const runner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-1",
        branchPrefix: "wf",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        run,
      });

      const result = await runner.run("Return JSON", {
        label: "Structured Failure",
        schema: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string" } },
        },
      });
      const journal = await store.readJournal("run-1");

      expect(vi.mocked(run).mock.calls[0]?.[0].output).toBeUndefined();
      expect(result).toMatchObject({
        branch: "wf/run-1/001-structured-failure",
        commits: [{ sha: "f00dbabe" }],
        sessionId: "session-structured",
        status: "failed",
        error: {
          name: "StructuredOutputError",
          message: `Structured output tag <${WORKFLOW_AGENT_OUTPUT_TAG}> not found in agent output`,
        },
      });
      expect(result).not.toHaveProperty("output");
      expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
        "prompt",
        "stdout",
        "result",
        "run",
        "log",
      ]);
      const stdoutPath = result.artifacts.find(
        (artifact) => artifact.name === "stdout",
      )?.path;
      const resultPath = result.artifacts.find(
        (artifact) => artifact.name === "result",
      )?.path;
      const runPath = result.artifacts.find(
        (artifact) => artifact.name === "run",
      )?.path;

      expect(stdoutPath).toBeDefined();
      expect(resultPath).toBeDefined();
      expect(runPath).toBeDefined();
      expect(await readFile(stdoutPath!, "utf8")).toBe(
        "stdout without the requested tag",
      );
      expect(JSON.parse(await readFile(resultPath!, "utf8"))).toMatchObject({
        status: "failed",
        error: {
          name: "StructuredOutputError",
          message: `Structured output tag <${WORKFLOW_AGENT_OUTPUT_TAG}> not found in agent output`,
        },
      });
      expect(JSON.parse(await readFile(runPath!, "utf8"))).toMatchObject({
        branch: "wf/run-1/001-structured-failure",
        commits: [{ sha: "f00dbabe" }],
        logFilePath,
        sessionId: "session-structured",
        usage,
      });
      expect(journal[0]).toMatchObject({
        status: "failed",
        branch: "wf/run-1/001-structured-failure",
        commits: [{ sha: "f00dbabe" }],
        logFilePath,
        sessionId: "session-structured",
        usage,
        error: {
          name: "StructuredOutputError",
          message: `Structured output tag <${WORKFLOW_AGENT_OUTPUT_TAG}> not found in agent output`,
        },
      });
      expect(journal[0]).not.toHaveProperty("output");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replays a matching succeeded journal entry without invoking run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-agent-runner-"));
    try {
      const store = new WorkflowRunStore({ cwd: dir });
      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-1",
      });
      const firstRun = fakeRun(async (options) =>
        runResult(options, {
          stdout: "stored output",
          commits: [{ sha: "abc123" }],
          iterations: [{ sessionId: "session-1" }],
        }),
      );
      const firstRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-1",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        getPhase: () => "Build",
        run: firstRun,
      });

      await firstRunner.run("Reuse this", { label: "Reusable" });
      const resumeJournal = await store.readJournal("run-1");

      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-2",
      });
      const secondRun = fakeRun();
      const secondRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-2",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        resumeFromRunId: "run-1",
        resumeJournal,
        getPhase: () => "Build",
        run: secondRun,
      });

      const result = await secondRunner.run("Reuse this", {
        label: "Reusable",
      });
      const journal = await store.readJournal("run-2");
      const resultPath = result.artifacts.find(
        (artifact) => artifact.name === "result",
      )?.path;

      expect(secondRun).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        output: "stored output",
        branch: "wf/run-1/001-reusable",
        commits: [{ sha: "abc123" }],
        sessionId: "session-1",
        status: "skipped",
      });
      expect(journal[0]).toMatchObject({
        callId: "001-reusable",
        status: "skipped",
        output: "stored output",
        replayedFromRunId: "run-1",
        replayedFromCallId: "001-reusable",
      });
      expect(JSON.parse(await readFile(resultPath!, "utf8"))).toMatchObject({
        status: "skipped",
        reason: "replayed",
        replayedFrom: {
          runId: "run-1",
          callId: "001-reusable",
        },
        output: "stored output",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the call index in call hashes and replays identical calls by matching position", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-agent-runner-"));
    try {
      const store = new WorkflowRunStore({ cwd: dir });
      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-1",
      });
      const firstRun = fakeRun(async (options) =>
        runResult(options, {
          stdout:
            options.branchStrategy?.type === "branch"
              ? `stored ${options.branchStrategy.branch}`
              : "stored output",
        }),
      );
      const firstRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-1",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        run: firstRun,
      });

      await firstRunner.run("Same prompt", { label: "Worker" });
      await firstRunner.run("Same prompt", { label: "Worker" });
      const resumeJournal = await store.readJournal("run-1");

      expect(resumeJournal).toHaveLength(2);
      expect(resumeJournal[0]).toMatchObject({
        callIndex: 0,
        callId: "001-worker",
        status: "succeeded",
      });
      expect(resumeJournal[1]).toMatchObject({
        callIndex: 1,
        callId: "002-worker",
        status: "succeeded",
      });
      expect(resumeJournal[0]?.callHash).toMatch(/^[a-f0-9]{64}$/);
      expect(resumeJournal[1]?.callHash).toMatch(/^[a-f0-9]{64}$/);
      expect(resumeJournal[0]?.callHash).not.toBe(resumeJournal[1]?.callHash);

      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-2",
      });
      const secondRun = fakeRun();
      const secondRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-2",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        resumeFromRunId: "run-1",
        resumeJournal,
        run: secondRun,
      });

      const firstReplay = await secondRunner.run("Same prompt", {
        label: "Worker",
      });
      const secondReplay = await secondRunner.run("Same prompt", {
        label: "Worker",
      });
      const replayJournal = await store.readJournal("run-2");

      expect(secondRun).not.toHaveBeenCalled();
      expect(firstReplay).toMatchObject({
        output: "stored wf/run-1/001-worker",
        status: "skipped",
      });
      expect(secondReplay).toMatchObject({
        output: "stored wf/run-1/002-worker",
        status: "skipped",
      });
      expect(replayJournal[0]).toMatchObject({
        callIndex: 0,
        callHash: resumeJournal[0]?.callHash,
        replayedFromCallId: "001-worker",
        status: "skipped",
      });
      expect(replayJournal[1]).toMatchObject({
        callIndex: 1,
        callHash: resumeJournal[1]?.callHash,
        replayedFromCallId: "002-worker",
        status: "skipped",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not replay when the prompt changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-agent-runner-"));
    try {
      const store = new WorkflowRunStore({ cwd: dir });
      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-1",
      });
      const firstRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-1",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        run: fakeRun(async (options) =>
          runResult(options, { stdout: "old output" }),
        ),
      });

      await firstRunner.run("Old prompt", { label: "Worker" });
      const resumeJournal = await store.readJournal("run-1");

      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-2",
      });
      const secondRun = fakeRun(async (options) =>
        runResult(options, { stdout: "new output" }),
      );
      const secondRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-2",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        resumeFromRunId: "run-1",
        resumeJournal,
        run: secondRun,
      });

      const result = await secondRunner.run("New prompt", { label: "Worker" });

      expect(secondRun).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        output: "new output",
        status: "succeeded",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not replay when agent options change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-agent-runner-"));
    try {
      const store = new WorkflowRunStore({ cwd: dir });
      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-1",
      });
      const firstRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-1",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        run: fakeRun(async (options) =>
          runResult(options, { stdout: "old output" }),
        ),
      });

      await firstRunner.run("Same prompt", {
        label: "Worker",
        timeoutMs: 1_000,
      });
      const resumeJournal = await store.readJournal("run-1");

      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-2",
      });
      const secondRun = fakeRun(async (options) =>
        runResult(options, { stdout: "new output" }),
      );
      const secondRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-2",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        resumeFromRunId: "run-1",
        resumeJournal,
        run: secondRun,
      });

      const result = await secondRunner.run("Same prompt", {
        label: "Worker",
        timeoutMs: 2_000,
      });

      expect(secondRun).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        output: "new output",
        status: "succeeded",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not replay when the source hash changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-agent-runner-"));
    try {
      const store = new WorkflowRunStore({ cwd: dir });
      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-1",
      });
      const firstRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-1",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        run: fakeRun(async (options) =>
          runResult(options, { stdout: "old output" }),
        ),
      });

      await firstRunner.run("Same prompt", { label: "Worker" });
      const resumeJournal = await store.readJournal("run-1");

      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-2",
      });
      const secondRun = fakeRun(async (options) =>
        runResult(options, { stdout: "new output" }),
      );
      const secondRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-2",
        branchPrefix: "wf",
        sourceHash: "source-b",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        resumeFromRunId: "run-1",
        resumeJournal,
        run: secondRun,
      });

      const result = await secondRunner.run("Same prompt", {
        label: "Worker",
      });

      expect(secondRun).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        output: "new output",
        status: "succeeded",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not replay failed journal entries as success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-agent-runner-"));
    try {
      const store = new WorkflowRunStore({ cwd: dir });
      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-1",
      });
      const firstRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-1",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        run: fakeRun(async () => {
          throw new Error("agent failed");
        }),
      });

      await firstRunner.run("Same prompt", { label: "Worker" });
      const resumeJournal = await store.readJournal("run-1");

      await store.createRun({
        meta: { name: "Agent Runner Test" },
        runId: "run-2",
      });
      const secondRun = fakeRun(async (options) =>
        runResult(options, { stdout: "recovered output" }),
      );
      const secondRunner = new WorkflowAgentRunner({
        cwd: dir,
        runId: "run-2",
        branchPrefix: "wf",
        sourceHash: "source-a",
        defaultAgent: agent("agent"),
        defaultSandbox: sandbox("sandbox"),
        store,
        resumeFromRunId: "run-1",
        resumeJournal,
        run: secondRun,
      });

      const result = await secondRunner.run("Same prompt", {
        label: "Worker",
      });

      expect(secondRun).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        output: "recovered output",
        status: "succeeded",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly when a requested skill name is ambiguous", async () => {
    const run = fakeRun();
    const runner = new WorkflowAgentRunner({
      cwd: "/repo",
      runId: "run-1",
      branchPrefix: "wf",
      defaultAgent: agent("agent"),
      defaultSandbox: sandbox("sandbox"),
      skills: [
        { name: "review", source: "./skills/review-a" },
        { name: "review", source: "./skills/review-b" },
      ],
      run,
    });

    await expect(
      runner.run("Use the requested skill", { skills: ["review"] }),
    ).rejects.toThrow(WorkflowValidationError);
    await expect(
      runner.run("Use the requested skill", { skills: ["review"] }),
    ).rejects.toThrow("requested ambiguous skill: review");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails clearly when agent or sandbox is missing", async () => {
    const withNoAgent = new WorkflowAgentRunner({
      cwd: "/repo",
      runId: "run-1",
      branchPrefix: "wf",
      defaultSandbox: sandbox("sandbox"),
      run: fakeRun(),
    });
    await expect(withNoAgent.run("task")).rejects.toThrow(
      WorkflowValidationError,
    );
    await expect(withNoAgent.run("task")).rejects.toThrow(
      "requires an agent provider",
    );

    const withNoSandbox = new WorkflowAgentRunner({
      cwd: "/repo",
      runId: "run-1",
      branchPrefix: "wf",
      defaultAgent: agent("agent"),
      run: fakeRun(),
    });
    await expect(withNoSandbox.run("task")).rejects.toThrow(
      WorkflowValidationError,
    );
    await expect(withNoSandbox.run("task")).rejects.toThrow(
      "requires a sandbox provider",
    );
  });
});
