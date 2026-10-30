import { Effect } from "effect";
import { expect, test } from "vitest";
import { AgentError, DockerError, PromptError } from "./errors.js";
import {
  classifyPipelineFailure,
  createCircuitBreaker,
  ProviderUnavailableError,
  runTaskWithRetries,
  TaskAttemptsError,
} from "./TaskRetry.js";

const fiberFailure = (error: unknown) =>
  Effect.runPromise(Effect.fail(error)).catch((thrown: unknown) => thrown);

test("classifies provider, infrastructure and task failures through Effect fiber failures", async () => {
  expect(
    classifyPipelineFailure(
      await fiberFailure(
        new AgentError({
          message: "codex exited with code 1:\n429 Too Many Requests",
        }),
      ),
    ),
  ).toBe("provider");
  expect(
    classifyPipelineFailure(
      await fiberFailure(
        new AgentError({
          message:
            "claude-code exited with code 1:\n503\nProvider attempts: codex fell-back (rate-limit) -> claudeCode failed (unavailable)",
        }),
      ),
    ),
  ).toBe("provider");
  expect(
    classifyPipelineFailure(
      await fiberFailure(new DockerError({ message: "container died" })),
    ),
  ).toBe("infrastructure");
  expect(
    classifyPipelineFailure(
      await fiberFailure(
        new AgentError({ message: "codex exited with code 1:\ntests failed" }),
      ),
    ),
  ).toBe("task");
  expect(
    classifyPipelineFailure(
      await fiberFailure(new PromptError({ message: "bad arg" })),
    ),
  ).toBe("task");
  expect(
    classifyPipelineFailure(
      new Error("Implementation did not complete for issue 22"),
    ),
  ).toBe("task");
});

test("provider and infrastructure failures retry within the budget; task failures never retry", async () => {
  const providerError = await fiberFailure(
    new AgentError({ message: "x exited with code 1:\nrate limit" }),
  );
  const calls: number[] = [];
  const result = await runTaskWithRetries({
    retries: 1,
    run: async (attempt) => {
      calls.push(attempt);
      if (attempt === 1) throw providerError;
      return { commits: ["a"] };
    },
  });
  expect(calls).toEqual([1, 2]);
  expect(result.commits).toEqual(["a"]);
  expect(result.taskAttempts.map((a) => a.outcome)).toEqual([
    "provider",
    "succeeded",
  ]);

  const taskCalls: number[] = [];
  const failure = await runTaskWithRetries({
    retries: 3,
    run: async (attempt) => {
      taskCalls.push(attempt);
      throw new Error("Review changes-requested; branch retained");
    },
  }).catch((error: unknown) => error);
  expect(taskCalls).toEqual([1]);
  expect(failure).toBeInstanceOf(TaskAttemptsError);
  expect((failure as TaskAttemptsError).kind).toBe("task");

  const infraCalls: number[] = [];
  const exhausted = await runTaskWithRetries({
    retries: 2,
    run: async (attempt) => {
      infraCalls.push(attempt);
      throw await fiberFailure(
        new DockerError({ message: "daemon unavailable" }),
      );
    },
  }).catch((error: unknown) => error as TaskAttemptsError);
  expect(infraCalls).toEqual([1, 2, 3]);
  expect(exhausted.attempts.map((a) => a.outcome)).toEqual([
    "infrastructure",
    "infrastructure",
    "infrastructure",
  ]);
  expect(exhausted.message).toContain("DockerError: daemon unavailable");

  const none: number[] = [];
  await runTaskWithRetries({
    retries: 0,
    run: async (attempt) => {
      none.push(attempt);
      throw providerError;
    },
  }).catch(() => undefined);
  expect(none).toEqual([1]);
});

test("the circuit breaker opens after consecutive provider failures and blocks new attempts", async () => {
  const breaker = createCircuitBreaker(2);
  const providerError = await fiberFailure(
    new AgentError({ message: "x exited with code 1:\nnot logged in" }),
  );
  breaker.record("task");
  expect(breaker.consecutiveProviderFailures).toBe(0);
  const first = await runTaskWithRetries({
    retries: 0,
    breaker,
    run: async () => {
      throw providerError;
    },
  }).catch((e: unknown) => e);
  expect(first).toBeInstanceOf(TaskAttemptsError);
  expect(breaker.open).toBe(false);
  breaker.record("success");
  expect(breaker.consecutiveProviderFailures).toBe(0);
  const calls: number[] = [];
  await runTaskWithRetries({
    retries: 5,
    breaker,
    run: async (attempt) => {
      calls.push(attempt);
      throw providerError;
    },
  }).catch(() => undefined);
  expect(calls).toEqual([1, 2]);
  expect(breaker.open).toBe(true);
  const blocked = await runTaskWithRetries({
    breaker,
    run: async () => ({}),
  }).catch((e: unknown) => e);
  expect(blocked).toBeInstanceOf(ProviderUnavailableError);
  expect(() => createCircuitBreaker(0)).toThrow(RangeError);
});
