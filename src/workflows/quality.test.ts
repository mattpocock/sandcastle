import { describe, expect, it, vi } from "vitest";
import {
  checkpoint,
  completenessCheck,
  createWorkflowQualityHelpers,
  judgePanel,
  loopUntilDry,
  retry,
  verify,
  WorkflowCheckpointRequiredError,
} from "./quality.js";
import type {
  JsonSchema,
  WorkflowAgentInvoker,
  WorkflowAgentOptions,
  WorkflowAgentResult,
  WorkflowEvent,
} from "./types.js";

const agentResult = <Output = unknown>(
  output: Output,
): WorkflowAgentResult<Output> => ({
  output,
  branch: "workflow-agent",
  commits: [],
  artifacts: [],
  status: "succeeded",
});

function fakeAgent(): {
  readonly agent: WorkflowAgentInvoker;
  readonly runMock: ReturnType<typeof vi.fn>;
} {
  const runMock = vi.fn(
    async <Output = unknown>(prompt: string, _options?: WorkflowAgentOptions) =>
      agentResult({ prompt } as Output),
  );
  const agent = runMock as unknown as WorkflowAgentInvoker;
  agent.run = runMock as unknown as WorkflowAgentInvoker["run"];

  return { agent, runMock };
}

function fakeLogger(): {
  readonly events: Omit<WorkflowEvent, "timestamp">[];
  readonly logger: { event: ReturnType<typeof vi.fn> };
} {
  const events: Omit<WorkflowEvent, "timestamp">[] = [];
  const event = vi.fn((workflowEvent: Omit<WorkflowEvent, "timestamp">) => {
    events.push(workflowEvent);
  });

  return { events, logger: { event } };
}

describe("workflow quality helpers", () => {
  it("retry retries failed attempts and succeeds without extra calls", async () => {
    const { events, logger } = fakeLogger();
    const thunk = vi.fn((attemptIndex: number) => {
      if (attemptIndex < 2) {
        throw new Error(`failed ${attemptIndex}`);
      }

      return "ok";
    });

    await expect(retry(thunk, { retries: 5, logger })).resolves.toBe("ok");

    expect(thunk).toHaveBeenCalledTimes(3);
    expect(events.map((event) => event.type)).toEqual([
      "quality_retry_attempt",
      "quality_retry_failed",
      "quality_retry_attempt",
      "quality_retry_failed",
      "quality_retry_attempt",
      "quality_retry_succeeded",
    ]);
  });

  it("retry throws the final error after exhaustion", async () => {
    const firstError = new Error("first");
    const finalError = new Error("final");
    const thunk = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(finalError);

    await expect(retry(thunk, { maxAttempts: 2 })).rejects.toBe(finalError);
    expect(thunk).toHaveBeenCalledTimes(2);
  });

  it("loopUntilDry stops on dry rounds and respects maxRounds", async () => {
    const { events, logger } = fakeLogger();
    const rounds = [["first"], ["second"], []] as const;
    const findMore = vi.fn(
      (roundIndex: number, previousResults: readonly string[]) => {
        if (roundIndex === 1) {
          expect(previousResults).toEqual(["first"]);
        }

        return rounds[roundIndex] ?? [];
      },
    );

    await expect(loopUntilDry(findMore, { logger })).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(findMore).toHaveBeenCalledTimes(3);
    expect(events.map((event) => event.type)).toContain("quality_loop_dry");

    const cappedFinder = vi.fn((roundIndex: number) => [roundIndex]);
    await expect(loopUntilDry(cappedFinder, { maxRounds: 2 })).resolves.toEqual(
      [0, 1],
    );
    expect(cappedFinder).toHaveBeenCalledTimes(2);
  });

  it("judgePanel calls the judge agent with candidate summaries", async () => {
    const { agent, runMock } = fakeAgent();

    await judgePanel(
      [
        { label: "Fast", summary: "Smallest diff and clear tests." },
        { label: "Thorough", summary: "Broader audit with more runtime cost." },
      ],
      { agent },
    );

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]?.[0]).toContain("Candidate summaries:");
    expect(runMock.mock.calls[0]?.[0]).toContain(
      "Candidate 1 (Fast):\nSmallest diff and clear tests.",
    );
    expect(runMock.mock.calls[0]?.[1]).toMatchObject({
      label: "Judge panel",
    });
  });

  it("verify and completenessCheck call agents with stable labels and prompts", async () => {
    const { agent, runMock } = fakeAgent();
    const schema: JsonSchema = {
      type: "object",
      properties: { verdict: { type: "string" } },
    };

    await verify("Finding A", { agent, schema });
    await completenessCheck({ summary: "Report A" }, { agent });

    expect(runMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("Finding to verify:\nFinding A"),
      { label: "Verify finding", schema },
    );
    expect(runMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Report to check:"),
      { label: "Completeness check", schema: undefined },
    );
  });

  it("checkpoint returns checkpoint_required by default and can throw explicitly", async () => {
    const { events, logger } = fakeLogger();

    await expect(
      checkpoint("Review before merge", { logger }),
    ).resolves.toEqual({
      status: "checkpoint_required",
      prompt: "Review before merge",
      label: "Checkpoint",
      policy: "require",
    });
    expect(events.map((event) => event.type)).toContain(
      "quality_checkpoint_required",
    );

    await expect(
      checkpoint("Stop here", { throwOnRequired: true }),
    ).rejects.toBeInstanceOf(WorkflowCheckpointRequiredError);
  });

  it("checkpoint auto policy returns an approved continued result", async () => {
    await expect(
      checkpoint("Continue automatically", { policy: "auto", label: "Gate" }),
    ).resolves.toEqual({
      status: "approved",
      prompt: "Continue automatically",
      label: "Gate",
      policy: "auto",
      continued: true,
    });
  });

  it("createWorkflowQualityHelpers binds supplied agent and logger", async () => {
    const { agent, runMock } = fakeAgent();
    const { events, logger } = fakeLogger();
    const quality = createWorkflowQualityHelpers({ agent, logger });

    await quality.verify("Bound finding");

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        type: "quality_verify_requested",
        message: "Verify finding",
        details: { label: "Verify finding" },
      },
    ]);
  });
});
