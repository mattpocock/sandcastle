import { describe, expect, it, vi } from "vitest";
import { WorkflowValidationError } from "./errors.js";
import { createWorkflowQualityHelpers } from "./quality.js";
import {
  createRestrictedWorkflowContext,
  executeWorkflowBody,
  type WorkflowVmGlobals,
} from "./WorkflowVm.js";
import type {
  JsonSchema,
  WorkflowAgentInvoker,
  WorkflowAgentResult,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowAgentCall,
  WorkflowParallelRunner,
  WorkflowPhaseReporter,
  WorkflowPipelineRunner,
  WorkflowRunState,
  WorkflowValidationResult,
  WorkflowValidator,
} from "./types.js";

const agentResult = <Output>(output: Output): WorkflowAgentResult<Output> => ({
  output,
  branch: "workflow-agent",
  commits: [],
  artifacts: [],
  status: "succeeded",
});

const createAgent = (): WorkflowAgentInvoker => {
  const invoke = vi.fn(async <Output = unknown>(prompt: string) =>
    agentResult({ prompt } as Output),
  ) as unknown as WorkflowAgentInvoker;
  invoke.run = vi.fn(async <Output = unknown>(prompt: string) =>
    agentResult({ prompt } as Output),
  ) as unknown as WorkflowAgentInvoker["run"];
  return invoke;
};

const createPhase = (): WorkflowPhaseReporter => {
  let currentPhase: string | undefined;
  const phase = vi.fn((title: string) => {
    currentPhase = title;
  }) as unknown as WorkflowPhaseReporter;
  phase.current = vi.fn(() => currentPhase);
  return phase;
};

const createGlobals = <Args>(
  args: Args,
  overrides: Partial<WorkflowVmGlobals<Args>> = {},
): WorkflowVmGlobals<Args> => {
  const parallel = vi.fn(async <T>(tasks: readonly (() => T | Promise<T>)[]) =>
    Promise.all(tasks.map((task) => task())),
  ) as unknown as WorkflowParallelRunner;
  parallel.agents = vi.fn(
    async <Output = unknown>(calls: readonly WorkflowAgentCall[]) =>
      calls.map((call) => agentResult({ prompt: call.prompt } as Output)),
  ) as unknown as WorkflowParallelRunner["agents"];

  const pipeline = vi.fn(async <T>(steps: readonly (() => T | Promise<T>)[]) =>
    Promise.all(steps.map((step) => step())),
  ) as WorkflowPipelineRunner;

  const event = vi.fn((_: Omit<WorkflowEvent, "timestamp">) => {});
  const validate = vi.fn(
    <Value>(
      value: unknown,
      _schema: JsonSchema,
    ): WorkflowValidationResult<Value> => ({
      ok: true,
      value: value as Value,
    }),
  ) as unknown as WorkflowValidator;

  const state = vi.fn(
    (): WorkflowRunState => ({
      id: "workflow-run",
      status: "running",
      cwd: "/repo",
      agentCount: 0,
      maxAgents: 3,
      concurrency: 2,
    }),
  );

  return {
    args,
    agent: createAgent(),
    parallel,
    pipeline,
    phase: createPhase(),
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      event,
    },
    validate,
    quality: createWorkflowQualityHelpers(),
    workflow: {
      id: "workflow-run",
      cwd: "/repo",
      state,
      stop: vi.fn(),
    },
    budget: {
      maxAgents: 3,
      agentCount: 0,
      concurrency: 2,
      remainingAgents: vi.fn(() => 3),
    },
    ...overrides,
  };
};

const loaded = <Args, Result>(
  run: WorkflowDefinition<Args, Result>["run"],
) => ({
  definition: {
    meta: { name: "test-workflow" },
    run,
  },
});

describe("executeWorkflowBody", () => {
  it("can return a literal result from definition.run", async () => {
    await expect(
      executeWorkflowBody(
        loaded(() => "done"),
        createGlobals(undefined),
      ),
    ).resolves.toBe("done");
  });

  it("can call injected agent primitive", async () => {
    const globals = createGlobals({ issue: 123 });

    const result = await executeWorkflowBody(
      loaded(async (ctx) => ctx.agent("fix the issue")),
      globals,
    );

    expect(result).toEqual(agentResult({ prompt: "fix the issue" }));
    expect(globals.agent).toHaveBeenCalledWith("fix the issue");
  });

  it("passes args and phase/log primitives through", async () => {
    const globals = createGlobals({ phaseName: "Implement" });

    const result = await executeWorkflowBody(
      loaded(async (ctx: WorkflowContext<{ phaseName: string }>) => {
        ctx.phase(ctx.args.phaseName);
        ctx.log.info("phase started", { phase: ctx.phase.current() });
        return ctx.phase.current();
      }),
      globals,
    );

    expect(result).toBe("Implement");
    expect(globals.phase).toHaveBeenCalledWith("Implement");
    expect(globals.log.info).toHaveBeenCalledWith("phase started", {
      phase: "Implement",
    });
  });

  it("throws clearly when loaded.definition.run is missing", async () => {
    await expect(
      executeWorkflowBody(
        { definition: { meta: { name: "bad" } } } as never,
        createGlobals(undefined),
      ),
    ).rejects.toThrow(WorkflowValidationError);

    await expect(
      executeWorkflowBody(
        { definition: { meta: { name: "bad" } } } as never,
        createGlobals(undefined),
      ),
    ).rejects.toThrow("Workflow definition is missing a run function.");
  });

  it("throws clearly when loaded.definition.run is not a function", async () => {
    await expect(
      executeWorkflowBody(
        {
          definition: {
            meta: { name: "bad" },
            run: "not-a-function",
          },
        } as never,
        createGlobals(undefined),
      ),
    ).rejects.toThrow("Workflow definition is missing a run function.");
  });

  it("propagates script errors with cause and message context", async () => {
    const cause = new Error("script exploded");

    try {
      await executeWorkflowBody(
        loaded(() => {
          throw cause;
        }),
        createGlobals(undefined),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("definition.run");
      expect((error as Error).cause).toBe(cause);
    }
  });

  it("cannot access process through the provided context object", async () => {
    const globals = createGlobals(undefined);

    const result = await executeWorkflowBody(
      loaded((ctx) => ({
        keys: Object.keys(ctx).sort(),
        hasProcess: "process" in ctx,
      })),
      globals,
    );

    expect(result).toEqual({
      keys: [
        "agent",
        "args",
        "budget",
        "log",
        "parallel",
        "phase",
        "pipeline",
        "validate",
        "workflow",
      ],
      hasProcess: false,
    });
  });

  it("works with async run", async () => {
    await expect(
      executeWorkflowBody(
        loaded(async () => {
          await Promise.resolve();
          return 42;
        }),
        createGlobals(undefined),
      ),
    ).resolves.toBe(42);
  });
});

describe("createRestrictedWorkflowContext", () => {
  it("copies only workflow context primitives from globals", () => {
    const globals = {
      ...createGlobals({ ok: true }),
      process: { env: {} },
    } as WorkflowVmGlobals<{ ok: boolean }> & { process: unknown };

    const ctx = createRestrictedWorkflowContext(globals);

    expect("process" in ctx).toBe(false);
    expect(ctx.args).toEqual({ ok: true });
  });
});
