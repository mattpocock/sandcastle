import { describe, expect, it } from "vitest";
import { WorkflowAgentLimitError, WorkflowStoppedError } from "./errors.js";
import { WorkflowScheduler } from "./WorkflowScheduler.js";

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

describe("WorkflowScheduler", () => {
  it("respects the concurrency cap", async () => {
    const scheduler = new WorkflowScheduler({ concurrency: 2, maxAgents: 10 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let running = 0;
    let maxRunning = 0;

    const resultsPromise = scheduler.parallel(
      gates.map((gate, index) => async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running--;
        return index;
      }),
    );

    await flushMicrotasks();

    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.queuedCount).toBe(2);
    expect(maxRunning).toBe(2);

    gates[0]?.resolve();
    await flushMicrotasks();

    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.queuedCount).toBe(1);

    gates[1]?.resolve();
    gates[2]?.resolve();
    gates[3]?.resolve();

    await expect(resultsPromise).resolves.toEqual([0, 1, 2, 3]);
    expect(maxRunning).toBe(2);
  });

  it("preserves input order for parallel results", async () => {
    const scheduler = new WorkflowScheduler({ concurrency: 3, maxAgents: 10 });
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();

    const resultsPromise = scheduler.parallel([
      () => first.promise,
      () => second.promise,
      () => third.promise,
    ]);

    await flushMicrotasks();

    third.resolve("third");
    second.resolve("second");
    first.resolve("first");

    await expect(resultsPromise).resolves.toEqual(["first", "second", "third"]);
  });

  it("throws before scheduling too many agent tasks", async () => {
    const scheduler = new WorkflowScheduler({ concurrency: 1, maxAgents: 2 });
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];

    const firstPromise = scheduler.scheduleAgent(async () => {
      started.push("first");
      return first.promise;
    });
    const secondPromise = scheduler.scheduleAgent(async () => {
      started.push("second");
      return second.promise;
    });
    expect(() =>
      scheduler.scheduleAgent(() => {
        started.push("third");
        return "third";
      }),
    ).toThrow(WorkflowAgentLimitError);

    await flushMicrotasks();

    expect(scheduler.agentCount).toBe(2);
    expect(scheduler.scheduledCount).toBe(2);
    expect(started).toEqual(["first"]);

    first.resolve("first");
    await flushMicrotasks();
    second.resolve("second");

    await expect(firstPromise).resolves.toBe("first");
    await expect(secondPromise).resolves.toBe("second");
    expect(started).toEqual(["first", "second"]);
  });

  it("aborting rejects queued tasks before they start", async () => {
    const controller = new AbortController();
    const scheduler = new WorkflowScheduler({
      concurrency: 1,
      maxAgents: 10,
      signal: controller.signal,
    });
    const active = deferred<string>();
    const started: string[] = [];

    const activePromise = scheduler.schedule(async () => {
      started.push("active");
      return active.promise;
    });
    const queuedPromise = scheduler.schedule(() => {
      started.push("queued");
      return "queued";
    });
    const queuedExpectation =
      expect(queuedPromise).rejects.toBeInstanceOf(WorkflowStoppedError);

    await flushMicrotasks();
    controller.abort("test abort");
    await flushMicrotasks();

    expect(scheduler.queuedCount).toBe(0);
    await queuedExpectation;
    expect(started).toEqual(["active"]);

    active.resolve("active");
    await expect(activePromise).resolves.toBe("active");
  });

  it("stop rejects queued tasks before they start", async () => {
    const scheduler = new WorkflowScheduler({ concurrency: 1, maxAgents: 10 });
    const active = deferred<string>();
    const started: string[] = [];
    let settled = false;

    const activePromise = scheduler.schedule(async () => {
      started.push("active");
      return active.promise;
    });
    const queuedPromise = scheduler.schedule(() => {
      started.push("queued");
      return "queued";
    });
    const queuedExpectation =
      expect(queuedPromise).rejects.toBeInstanceOf(WorkflowStoppedError);

    await flushMicrotasks();
    scheduler.stop("manual stop");
    const settledPromise = scheduler.waitForSettled().then(() => {
      settled = true;
    });
    await flushMicrotasks();

    await queuedExpectation;
    expect(started).toEqual(["active"]);
    expect(settled).toBe(false);

    active.resolve("active");
    await expect(activePromise).resolves.toBe("active");
    await settledPromise;
    expect(settled).toBe(true);
    await expect(scheduler.schedule(() => "new")).rejects.toBeInstanceOf(
      WorkflowStoppedError,
    );
  });

  it("runs beforeStart before launching queued tasks", async () => {
    const scheduler = new WorkflowScheduler({
      concurrency: 1,
      maxAgents: 10,
      beforeStart: () => {
        throw new WorkflowStoppedError("control stop");
      },
    });
    const started: string[] = [];

    const taskPromise = scheduler.schedule(() => {
      started.push("task");
      return "task";
    });

    await expect(taskPromise).rejects.toBeInstanceOf(WorkflowStoppedError);
    expect(started).toEqual([]);
  });

  it("propagates active task errors", async () => {
    const scheduler = new WorkflowScheduler({ concurrency: 1, maxAgents: 10 });
    const error = new Error("boom");

    await expect(
      scheduler.schedule(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it("fails clearly for invalid options", () => {
    expect(
      () => new WorkflowScheduler({ concurrency: 0, maxAgents: 1 }),
    ).toThrow(
      "WorkflowScheduler concurrency must be a positive finite integer.",
    );
    expect(
      () => new WorkflowScheduler({ concurrency: 1, maxAgents: Number.NaN }),
    ).toThrow("WorkflowScheduler maxAgents must be a positive finite integer.");
    expect(
      () => new WorkflowScheduler({ concurrency: 1.5, maxAgents: 1 }),
    ).toThrow(
      "WorkflowScheduler concurrency must be a positive finite integer.",
    );
  });
});
