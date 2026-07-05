import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "../AgentProvider.js";
import type { RunOptions, RunResult } from "../run.js";
import type { SandboxProvider } from "../SandboxProvider.js";
import type { WorkflowAgentJournalEntry, WorkflowEvent } from "./types.js";
import { runWorkflow } from "./WorkflowManager.js";
import {
  type WorkflowAgentRunFunction,
  WORKFLOW_AGENT_OUTPUT_TAG,
} from "./WorkflowAgentRunner.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(message);
}

async function withTempDir<T>(test: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-workflow-integration-"));
  try {
    return await test(dir);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  }
}

const readJson = async <Value = unknown>(path: string): Promise<Value> =>
  JSON.parse(await readFile(path, "utf8")) as Value;

const readJsonl = async <Value = unknown>(path: string): Promise<Value[]> => {
  const content = await readFile(path, "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Value);
};

const workflowSource = `
  export default {
    meta: {
      name: "integration-smoke",
      description: "Dynamic workflow integration smoke test",
    },
    async run(ctx) {
      const items =
        Array.isArray(ctx.args?.items) && ctx.args.items.length > 0
          ? ctx.args.items
          : ["Alpha", "Beta", "Gamma"];

      await ctx.phase("Discover");

      const workerSchema = {
        type: "object",
        required: ["item", "finding", "score"],
        properties: {
          item: { type: "string" },
          finding: { type: "string" },
          score: { type: "integer" },
        },
        additionalProperties: false,
      };

      await ctx.phase("Analyze");

      const workerResults = await ctx.parallel.agents(
        items.map((item) => ({
          prompt: \`Analyze \${item} and return one structured finding.\`,
          options: {
            label: \`Worker \${item}\`,
            schema: workerSchema,
          },
        })),
        { concurrency: 2 },
      );

      await ctx.phase("Synthesize");

      const outputs = workerResults.map((result) => result.output);
      const synthesis = {
        title: "Integration synthesis",
        items: outputs.map((output) => output.item),
        highlights: outputs.map((output) => \`\${output.item}: \${output.finding}\`),
        totalScore: outputs.reduce((sum, output) => sum + output.score, 0),
        summary: outputs.map((output) => output.finding).join(" / "),
      };
      const validated = ctx.validate(synthesis, {
        type: "object",
        required: ["title", "items", "highlights", "totalScore", "summary"],
        properties: {
          title: { type: "string" },
          items: { type: "array", items: { type: "string" } },
          highlights: { type: "array", items: { type: "string" } },
          totalScore: { type: "integer" },
          summary: { type: "string" },
        },
      });

      if (!validated.ok) {
        throw new Error("Final synthesis failed validation.");
      }

      return {
        synthesis: validated.value,
        workerStatuses: workerResults.map((result) => result.status),
        workerArtifactNames: workerResults.map((result) =>
          result.artifacts.map((artifact) => artifact.name),
        ),
      };
    },
  };
`;

const fakeAgent = (): AgentProvider => ({
  name: "fake-agent",
  env: {},
  captureSessions: false,
  buildPrintCommand: vi.fn(() => {
    throw new Error("real agent command should not be built");
  }),
  parseStreamLine: vi.fn(() => []),
});

const fakeSandbox = (): SandboxProvider =>
  ({
    tag: "none",
    name: "fake-sandbox",
    env: {},
    create: vi.fn(async () => {
      throw new Error("real sandbox should not be created");
    }),
  }) satisfies SandboxProvider;

const workerOutputByName = {
  "Worker Alpha": {
    item: "Alpha",
    finding: "Alpha has a stable plan",
    score: 10,
  },
  "Worker Beta": {
    item: "Beta",
    finding: "Beta has clear dependencies",
    score: 20,
  },
  "Worker Gamma": {
    item: "Gamma",
    finding: "Gamma is ready for synthesis",
    score: 30,
  },
} as const;

type WorkerOutput =
  (typeof workerOutputByName)[keyof typeof workerOutputByName];

const createControlledAgentRun = () => {
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const startedNames: string[] = [];
  let activeCount = 0;
  let maxActiveCount = 0;

  const run = vi.fn(async (options: RunOptions): Promise<RunResult> => {
    const name = options.name ?? "unnamed-agent";
    const output = workerOutputByName[name as keyof typeof workerOutputByName];

    if (output === undefined) {
      throw new Error(`Unexpected fake agent call: ${name}`);
    }

    activeCount++;
    maxActiveCount = Math.max(maxActiveCount, activeCount);
    startedNames.push(name);

    const gate = deferred();
    gates.set(name, gate);

    try {
      await gate.promise;
    } finally {
      activeCount--;
    }

    return {
      iterations: [
        {
          sessionId: `session-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          usage: {
            inputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 1,
          },
        },
      ],
      stdout: [
        `fake stdout for ${name}`,
        `<${WORKFLOW_AGENT_OUTPUT_TAG}>${JSON.stringify(
          output,
        )}</${WORKFLOW_AGENT_OUTPUT_TAG}>`,
      ].join("\n"),
      commits: [{ sha: `sha-${output.item.toLowerCase()}` }],
      branch:
        options.branchStrategy?.type === "branch"
          ? options.branchStrategy.branch
          : "unexpected-head",
    };
  }) as unknown as WorkflowAgentRunFunction;

  return {
    run,
    release(name: keyof typeof workerOutputByName): void {
      const gate = gates.get(name);
      if (gate === undefined) {
        throw new Error(`Fake agent call has not started: ${name}`);
      }

      gate.resolve(undefined);
    },
    get activeCount(): number {
      return activeCount;
    },
    get maxActiveCount(): number {
      return maxActiveCount;
    },
    get startedNames(): readonly string[] {
      return startedNames;
    },
  };
};

describe("dynamic workflow integration smoke test", () => {
  it("runs a full fake-provider workflow with structured parallel agents and persisted artifacts", async () => {
    await withTempDir(async (cwd) => {
      const agent = fakeAgent();
      const sandbox = fakeSandbox();
      const controlledRun = createControlledAgentRun();

      const runPromise = runWorkflow({
        cwd,
        source: workflowSource,
        args: { items: ["Alpha", "Beta", "Gamma"] },
        runId: "integration-smoke-run",
        runsRoot: "runs",
        concurrency: 2,
        maxAgents: 3,
        defaultAgent: agent,
        defaultSandbox: sandbox,
        agentRun: controlledRun.run,
      });

      await waitFor(
        () => controlledRun.startedNames.length === 2,
        "Expected first two fake agent calls to start.",
      );

      expect(controlledRun.activeCount).toBe(2);
      expect(controlledRun.maxActiveCount).toBe(2);
      expect([...controlledRun.startedNames].sort()).toEqual([
        "Worker Alpha",
        "Worker Beta",
      ]);
      expect(controlledRun.startedNames).not.toContain("Worker Gamma");

      controlledRun.release("Worker Alpha");

      await waitFor(
        () => controlledRun.startedNames.includes("Worker Gamma"),
        "Expected queued fake agent call to start after one worker completed.",
      );

      expect(controlledRun.activeCount).toBe(2);
      expect(controlledRun.maxActiveCount).toBe(2);
      expect([...controlledRun.startedNames].sort()).toEqual([
        "Worker Alpha",
        "Worker Beta",
        "Worker Gamma",
      ]);

      controlledRun.release("Worker Beta");
      controlledRun.release("Worker Gamma");

      const result = await runPromise;
      const runDir = join(cwd, "runs", "integration-smoke-run");

      expect(result).toMatchObject({
        runId: "integration-smoke-run",
        status: "succeeded",
        runDir,
        result: {
          synthesis: {
            title: "Integration synthesis",
            items: ["Alpha", "Beta", "Gamma"],
            highlights: [
              "Alpha: Alpha has a stable plan",
              "Beta: Beta has clear dependencies",
              "Gamma: Gamma is ready for synthesis",
            ],
            totalScore: 60,
            summary:
              "Alpha has a stable plan / Beta has clear dependencies / Gamma is ready for synthesis",
          },
          workerStatuses: ["succeeded", "succeeded", "succeeded"],
          workerArtifactNames: [
            ["prompt", "stdout", "result", "run"],
            ["prompt", "stdout", "result", "run"],
            ["prompt", "stdout", "result", "run"],
          ],
        },
      });

      await expect(access(join(runDir, "state.json"))).resolves.toBeUndefined();
      await expect(
        access(join(runDir, "result.json")),
      ).resolves.toBeUndefined();
      await expect(readJson(join(runDir, "state.json"))).resolves.toMatchObject(
        {
          id: "integration-smoke-run",
          status: "succeeded",
          agentCount: 3,
          maxAgents: 3,
          concurrency: 2,
          currentPhase: "Synthesize",
          result: result.result,
        },
      );
      await expect(readJson(join(runDir, "result.json"))).resolves.toEqual(
        result.result,
      );

      const events = await readJsonl<WorkflowEvent>(
        join(runDir, "events.jsonl"),
      );
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "phase_started",
          "agent_started",
          "agent_succeeded",
          "workflow_succeeded",
        ]),
      );
      expect(
        events
          .filter((event) => event.type === "phase_started")
          .map((event) => event.message),
      ).toEqual(["Discover", "Analyze", "Synthesize"]);
      expect(
        events
          .filter((event) => event.type === "agent_started")
          .map((event) => event.message)
          .sort(),
      ).toEqual(["Worker Alpha", "Worker Beta", "Worker Gamma"]);
      const succeededAgentEvents = events
        .filter((event) => event.type === "agent_succeeded")
        .map((event) => event.message)
        .sort();
      expect(succeededAgentEvents).toEqual([
        "Worker Alpha",
        "Worker Beta",
        "Worker Gamma",
      ]);

      const journal = await readJsonl<WorkflowAgentJournalEntry>(
        join(runDir, "journal.jsonl"),
      );
      const journalByCallIndex = [...journal].sort(
        (left, right) => left.callIndex - right.callIndex,
      );
      const journalByLabel = [...journal].sort((left, right) =>
        left.label.localeCompare(right.label),
      );
      expect(journal).toHaveLength(3);
      expect([...journal.map((entry) => entry.callIndex)].sort()).toEqual([
        0, 1, 2,
      ]);
      expect(journalByLabel.map((entry) => entry.label)).toEqual([
        "Worker Alpha",
        "Worker Beta",
        "Worker Gamma",
      ]);
      expect(journalByLabel.map((entry) => entry.phase)).toEqual([
        "Analyze",
        "Analyze",
        "Analyze",
      ]);
      expect(journalByLabel.map((entry) => entry.status)).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
      ]);
      expect(journalByLabel.map((entry) => entry.output)).toEqual([
        workerOutputByName["Worker Alpha"],
        workerOutputByName["Worker Beta"],
        workerOutputByName["Worker Gamma"],
      ]);

      for (const entry of journalByLabel) {
        const output =
          workerOutputByName[entry.label as keyof typeof workerOutputByName];

        expect(entry.callId).toMatch(
          new RegExp(`^00[1-3]-worker-${output.item.toLowerCase()}$`),
        );

        const agentDir = join(runDir, "agents", entry.callId);
        await expect(access(agentDir)).resolves.toBeUndefined();
        await expect(
          access(join(agentDir, "prompt.md")),
        ).resolves.toBeUndefined();
        await expect(
          access(join(agentDir, "stdout.txt")),
        ).resolves.toBeUndefined();
        await expect(
          access(join(agentDir, "run.json")),
        ).resolves.toBeUndefined();
        await expect(readJson(join(agentDir, "result.json"))).resolves.toEqual(
          output,
        );
      }

      const fakeRunCalls = vi
        .mocked(controlledRun.run)
        .mock.calls.map(([options]) => options);
      expect(fakeRunCalls).toHaveLength(3);
      expect(
        fakeRunCalls.every((options) => options.output === undefined),
      ).toBe(true);
      expect(fakeRunCalls.every((options) => options.maxIterations === 1)).toBe(
        true,
      );
      expect(
        fakeRunCalls.every((options) => options.prompt?.includes('"score": {')),
      ).toBe(true);
      expect(agent.buildPrintCommand).not.toHaveBeenCalled();
      expect(sandbox.create).not.toHaveBeenCalled();
      expect(controlledRun.maxActiveCount).toBeLessThanOrEqual(2);

      // Replay matching is call-index ordered, so resume with the prior journal order.
      const replayedOutputsByCallIndex = journalByCallIndex.map(
        (entry) => entry.output as WorkerOutput,
      );
      const replayItems = replayedOutputsByCallIndex.map(
        (output) => output.item,
      );
      const expectedReplaySynthesis = {
        title: "Integration synthesis",
        items: replayItems,
        highlights: replayedOutputsByCallIndex.map(
          (output) => `${output.item}: ${output.finding}`,
        ),
        totalScore: replayedOutputsByCallIndex.reduce(
          (sum, output) => sum + output.score,
          0,
        ),
        summary: replayedOutputsByCallIndex
          .map((output) => output.finding)
          .join(" / "),
      };
      const replayOnlyRun = vi.fn(async () => {
        throw new Error("Resumed workflow should replay all agent calls.");
      }) as unknown as WorkflowAgentRunFunction;
      const resumedResult = await runWorkflow({
        cwd,
        source: workflowSource,
        args: { items: replayItems },
        runId: "integration-smoke-resume-run",
        runsRoot: "runs",
        resume: { fromRunId: "integration-smoke-run" },
        concurrency: 1,
        maxAgents: 3,
        defaultAgent: agent,
        defaultSandbox: sandbox,
        agentRun: replayOnlyRun,
      });
      const resumedRunDir = join(cwd, "runs", "integration-smoke-resume-run");

      expect(replayOnlyRun).not.toHaveBeenCalled();
      expect(resumedResult).toMatchObject({
        runId: "integration-smoke-resume-run",
        status: "succeeded",
        runDir: resumedRunDir,
        result: {
          synthesis: expectedReplaySynthesis,
          workerStatuses: ["skipped", "skipped", "skipped"],
          workerArtifactNames: [
            ["prompt", "result", "run"],
            ["prompt", "result", "run"],
            ["prompt", "result", "run"],
          ],
        },
      });

      await expect(
        readJson(join(resumedRunDir, "state.json")),
      ).resolves.toMatchObject({
        id: "integration-smoke-resume-run",
        status: "succeeded",
        agentCount: 3,
        maxAgents: 3,
        concurrency: 1,
        currentPhase: "Synthesize",
        result: resumedResult.result,
      });
      await expect(
        readJson(join(resumedRunDir, "result.json")),
      ).resolves.toEqual(resumedResult.result);

      const resumedEvents = await readJsonl<WorkflowEvent>(
        join(resumedRunDir, "events.jsonl"),
      );
      expect(
        resumedEvents
          .filter((event) => event.type === "agent_replayed")
          .map((event) => event.message)
          .sort(),
      ).toEqual(["Worker Alpha", "Worker Beta", "Worker Gamma"]);
      expect(
        resumedEvents.filter((event) => event.type === "agent_succeeded"),
      ).toHaveLength(0);

      const replayJournal = await readJsonl<WorkflowAgentJournalEntry>(
        join(resumedRunDir, "journal.jsonl"),
      );
      const replayJournalByCallIndex = [...replayJournal].sort(
        (left, right) => left.callIndex - right.callIndex,
      );
      expect(replayJournalByCallIndex).toHaveLength(3);

      for (const [index, replayEntry] of replayJournalByCallIndex.entries()) {
        const originalEntry = journalByCallIndex[index];
        expect(originalEntry).toBeDefined();
        expect(replayEntry).toMatchObject({
          callId: originalEntry?.callId,
          callIndex: originalEntry?.callIndex,
          callHash: originalEntry?.callHash,
          label: originalEntry?.label,
          phase: "Analyze",
          status: "skipped",
          branch: originalEntry?.branch,
          commits: originalEntry?.commits,
          sessionId: originalEntry?.sessionId,
          usage: originalEntry?.usage,
          output: originalEntry?.output,
          replayedFromRunId: "integration-smoke-run",
          replayedFromCallId: originalEntry?.callId,
        });

        const agentDir = join(resumedRunDir, "agents", replayEntry.callId);
        await expect(
          access(join(agentDir, "prompt.md")),
        ).resolves.toBeUndefined();
        await expect(access(join(agentDir, "stdout.txt"))).rejects.toThrow();
        await expect(readJson(join(agentDir, "result.json"))).resolves.toEqual({
          status: "skipped",
          reason: "replayed",
          replayedFrom: {
            runId: "integration-smoke-run",
            callId: originalEntry?.callId,
            callHash: originalEntry?.callHash,
          },
          output: originalEntry?.output,
        });
        await expect(
          readJson(join(agentDir, "run.json")),
        ).resolves.toMatchObject({
          branch: originalEntry?.branch,
          commits: originalEntry?.commits,
          sessionId: originalEntry?.sessionId,
          usage: originalEntry?.usage,
          replayedFrom: {
            runId: "integration-smoke-run",
            callId: originalEntry?.callId,
            callHash: originalEntry?.callHash,
          },
        });
      }

      expect(agent.buildPrintCommand).not.toHaveBeenCalled();
      expect(sandbox.create).not.toHaveBeenCalled();
    });
  });
});
