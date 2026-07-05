import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkflowStoppedError } from "./errors.js";
import {
  createWorkflowPrimitives,
  type WorkflowPrimitivesOptions,
} from "./WorkflowPrimitives.js";
import type { WorkflowAgentRunner } from "./WorkflowAgentRunner.js";
import { WorkflowRunStore } from "./WorkflowRunStore.js";
import { WorkflowScheduler } from "./WorkflowScheduler.js";
import type {
  WorkflowAgentOptions,
  WorkflowAgentResult,
  WorkflowMeta,
  WorkflowRunState,
} from "./types.js";

const meta: WorkflowMeta = {
  name: "Primitive Workflow",
};

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

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const agentResult = <Output = unknown>(
  overrides: Partial<WorkflowAgentResult<Output>> = {},
): WorkflowAgentResult<Output> => ({
  output: "ok" as Output,
  branch: "sandcastle/workflows/run-1/001-agent",
  commits: [],
  artifacts: [],
  status: "succeeded",
  ...overrides,
});

function fakeAgentRunner(
  implementation?: (
    prompt: string,
    options?: WorkflowAgentOptions,
  ) => Promise<WorkflowAgentResult> | WorkflowAgentResult,
): Pick<WorkflowAgentRunner, "run"> & {
  readonly runMock: ReturnType<typeof vi.fn>;
} {
  const runMock = vi.fn((prompt: string, options?: WorkflowAgentOptions) =>
    Promise.resolve(
      implementation === undefined
        ? agentResult({ output: prompt })
        : implementation(prompt, options),
    ),
  );

  return {
    run: runMock as unknown as Pick<WorkflowAgentRunner, "run">["run"],
    runMock,
  };
}

async function withRun<T>(
  test: (options: {
    readonly cwd: string;
    readonly store: WorkflowRunStore;
    readonly state: WorkflowRunState;
  }) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "sandcastle-primitives-"));

  try {
    const store = new WorkflowRunStore({
      cwd,
      now: () => new Date("2026-07-05T10:11:12.000Z"),
      random: () => "ABC12345",
    });
    const state = await store.createRun({
      meta,
      runId: "run-1",
      status: "running",
      maxAgents: 5,
      concurrency: 3,
    });

    return await test({ cwd, store, state });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function primitives<Args>(
  options: Omit<
    WorkflowPrimitivesOptions<Args>,
    "scheduler" | "agentRunner"
  > & {
    readonly scheduler?: WorkflowScheduler;
    readonly agentRunner?: Pick<WorkflowAgentRunner, "run">;
  },
) {
  return createWorkflowPrimitives({
    scheduler:
      options.scheduler ?? new WorkflowScheduler({ concurrency: 3, maxAgents: 5 }),
    agentRunner: options.agentRunner ?? fakeAgentRunner(),
    ...options,
  });
}

describe("createWorkflowPrimitives", () => {
  it("phase updates current phase, emits phase_started, and persists state", async () => {
    await withRun(async ({ cwd, store, state }) => {
      const ctx = primitives({
        args: {},
        runId: state.id,
        cwd,
        store,
        initialState: state,
      });

      await ctx.phase("Plan");

      expect(ctx.phase.current()).toBe("Plan");
      expect(await store.readState(state.id)).toMatchObject({
        id: state.id,
        currentPhase: "Plan",
      });
      expect(await store.readEvents(state.id)).toMatchObject([
        {
          type: "phase_started",
          message: "Plan",
          details: { title: "Plan" },
          timestamp: expect.any(String),
        },
      ]);
    });
  });

  it("log methods and log.event append events with timestamps", async () => {
    await withRun(async ({ cwd, store, state }) => {
      const ctx = primitives({
        args: {},
        runId: state.id,
        cwd,
        store,
        initialState: state,
      });

      await ctx.log.debug("Debug", { step: 1 });
      await ctx.log.info("Info");
      await ctx.log.warn("Warn", ["detail"]);
      await ctx.log.error("Error");
      await ctx.log.event({ type: "custom_event", details: { ok: true } });

      expect(await store.readEvents(state.id)).toMatchObject([
        {
          type: "log_debug",
          message: "Debug",
          details: { step: 1 },
          timestamp: expect.any(String),
        },
        { type: "log_info", message: "Info", timestamp: expect.any(String) },
        {
          type: "log_warn",
          message: "Warn",
          details: ["detail"],
          timestamp: expect.any(String),
        },
        { type: "log_error", message: "Error", timestamp: expect.any(String) },
        {
          type: "custom_event",
          details: { ok: true },
          timestamp: expect.any(String),
        },
      ]);
    });
  });

  it("agent schedules through scheduler.scheduleAgent, emits lifecycle events, and updates budget", async () => {
    await withRun(async ({ cwd, store, state }) => {
      const scheduler = new WorkflowScheduler({ concurrency: 2, maxAgents: 5 });
      const scheduleAgentSpy = vi.spyOn(scheduler, "scheduleAgent");
      const runner = fakeAgentRunner(() =>
        agentResult({ output: { answer: 42 }, branch: "branch-a" }),
      );
      const ctx = primitives({
        args: {},
        runId: state.id,
        cwd,
        store,
        initialState: state,
        scheduler,
        agentRunner: runner,
      });

      const result = await ctx.agent("Do work", { label: "Worker" });

      expect(scheduleAgentSpy).toHaveBeenCalledTimes(1);
      expect(runner.runMock).toHaveBeenCalledWith("Do work", {
        label: "Worker",
      });
      expect(result).toMatchObject({
        status: "succeeded",
        output: { answer: 42 },
      });
      expect(ctx.budget.agentCount).toBe(1);
      expect(await store.readEvents(state.id)).toMatchObject([
        {
          type: "agent_started",
          message: "Worker",
          timestamp: expect.any(String),
        },
        {
          type: "agent_succeeded",
          message: "Worker",
          details: {
            label: "Worker",
            status: "succeeded",
            branch: "branch-a",
          },
          timestamp: expect.any(String),
        },
      ]);
    });
  });

  it("failed agents emit agent_failed and return failed results", async () => {
    await withRun(async ({ cwd, store, state }) => {
      const runner = fakeAgentRunner(() =>
        agentResult({
          status: "failed",
          error: { message: "agent failed" },
          output: undefined,
        }),
      );
      const ctx = primitives({
        args: {},
        runId: state.id,
        cwd,
        store,
        initialState: state,
        agentRunner: runner,
      });

      const result = await ctx.agent.run("Break", { label: "Breaker" });

      expect(result).toMatchObject({
        status: "failed",
        error: { message: "agent failed" },
      });
      expect(await store.readEvents(state.id)).toMatchObject([
        { type: "agent_started", message: "Breaker" },
        {
          type: "agent_failed",
          message: "Breaker",
          details: {
            label: "Breaker",
            status: "failed",
            error: { message: "agent failed" },
          },
        },
      ]);
    });
  });

  it("rejected agent runners emit agent_failed and propagate the error", async () => {
    await withRun(async ({ cwd, store, state }) => {
      const error = new Error("runner exploded");
      const runner = fakeAgentRunner(async () => {
        throw error;
      });
      const ctx = primitives({
        args: {},
        runId: state.id,
        cwd,
        store,
        initialState: state,
        agentRunner: runner,
      });

      await expect(ctx.agent("Explode", { label: "Exploder" })).rejects.toBe(
        error,
      );
      expect(await store.readEvents(state.id)).toMatchObject([
        { type: "agent_started", message: "Exploder" },
        {
          type: "agent_failed",
          message: "Exploder",
          details: {
            label: "Exploder",
            error: {
              name: "Error",
              message: "runner exploded",
              stack: expect.any(String),
            },
          },
        },
      ]);
    });
  });

  it("parallel preserves input order under constrained per-call concurrency", async () => {
    const scheduler = new WorkflowScheduler({ concurrency: 3, maxAgents: 5 });
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    const ctx = primitives({
      args: {},
      runId: "run-1",
      cwd: "/repo",
      scheduler,
    });
    let running = 0;
    let maxRunning = 0;

    const resultsPromise = ctx.parallel(
      gates.map((gate, index) => async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        const value = await gate.promise;
        running--;
        return value + index;
      }),
      { concurrency: 2 },
    );

    await flushMicrotasks();
    expect(maxRunning).toBe(2);
    expect(scheduler.queuedCount).toBe(0);

    gates[1]?.resolve(20);
    await flushMicrotasks();
    gates[0]?.resolve(10);
    await flushMicrotasks();
    gates[2]?.resolve(30);

    await expect(resultsPromise).resolves.toEqual([10, 21, 32]);
  });

  it("parallel.agents preserves order and schedules agent calls", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<WorkflowAgentResult>>>();
    const runner = fakeAgentRunner((prompt) => {
      const gate = deferred<WorkflowAgentResult>();
      gates.set(prompt, gate);
      return gate.promise;
    });
    const ctx = primitives({
      args: {},
      runId: "run-1",
      cwd: "/repo",
      scheduler: new WorkflowScheduler({ concurrency: 3, maxAgents: 5 }),
      agentRunner: runner,
    });

    const resultsPromise = ctx.parallel.agents([
      { prompt: "first", options: { label: "First" } },
      { prompt: "second", options: { label: "Second" } },
      { prompt: "third", options: { label: "Third" } },
    ]);

    await flushMicrotasks();
    gates.get("third")?.resolve(agentResult({ output: "third" }));
    gates.get("second")?.resolve(agentResult({ output: "second" }));
    gates.get("first")?.resolve(agentResult({ output: "first" }));

    await expect(resultsPromise).resolves.toMatchObject([
      { output: "first" },
      { output: "second" },
      { output: "third" },
    ]);
    expect(runner.runMock).toHaveBeenCalledTimes(3);
    expect(ctx.budget.agentCount).toBe(3);
  });

  it("pipeline executes steps sequentially", async () => {
    const ctx = primitives({ args: {}, runId: "run-1", cwd: "/repo" });
    const order: string[] = [];

    const result = await ctx.pipeline([
      async () => {
        order.push("first");
        await flushMicrotasks();
        order.push("first done");
        return 1;
      },
      () => {
        order.push("second");
        return 2;
      },
    ]);

    expect(result).toEqual([1, 2]);
    expect(order).toEqual(["first", "first done", "second"]);
  });

  it("validate returns ok true and false for JSON Schema values", () => {
    const ctx = primitives({ args: {}, runId: "run-1", cwd: "/repo" });
    const schema = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    } as const;

    expect(ctx.validate({ name: "Sandcastle" }, schema)).toEqual({
      ok: true,
      value: { name: "Sandcastle" },
    });
    expect(ctx.validate({ name: 123 }, schema)).toMatchObject({
      ok: false,
      errors: [
        {
          code: "json_schema",
          message: "Expected string",
          path: ["name"],
          severity: "error",
        },
      ],
    });
  });

  it("workflow.stop stops queued work, emits workflow_stopped, updates state, and budget reflects limits", async () => {
    await withRun(async ({ cwd, store, state }) => {
      const gate = deferred<WorkflowAgentResult>();
      const runner = fakeAgentRunner(() => gate.promise);
      const ctx = primitives({
        args: {},
        runId: state.id,
        cwd,
        store,
        initialState: state,
        scheduler: new WorkflowScheduler({ concurrency: 1, maxAgents: 2 }),
        agentRunner: runner,
      });

      const activePromise = ctx.agent("active", { label: "Active" });
      const queuedPromise = ctx.agent("queued", { label: "Queued" });
      const queuedExpectation =
        expect(queuedPromise).rejects.toBeInstanceOf(WorkflowStoppedError);

      await flushMicrotasks();
      expect(ctx.budget.agentCount).toBe(2);
      expect(ctx.budget.remainingAgents()).toBe(0);

      await ctx.workflow.stop("manual stop");

      await queuedExpectation;
      expect(ctx.workflow.state()).toMatchObject({
        status: "stopped",
        agentCount: 2,
      });
      expect(await store.readState(state.id)).toMatchObject({
        status: "stopped",
        agentCount: 2,
      });
      expect(await store.readEvents(state.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "workflow_stopped",
            message: "manual stop",
            details: { reason: "manual stop" },
          }),
        ]),
      );

      gate.resolve(agentResult({ output: "active done" }));
      await expect(activePromise).resolves.toMatchObject({
        output: "active done",
      });
    });
  });
});
