import { FileSystem } from "@effect/platform";
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  TestClock,
  TestContext,
} from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeTimeoutError } from "./errors.js";
import { create, pruneStale } from "./WorktreeManager.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const fs = FileSystem.makeNoop({
  makeDirectory: () => Effect.void,
  readDirectory: () => Effect.succeed([]),
  realPath: (path) => Effect.succeed(path),
});

describe.each(["create", "prune"] as const)(
  "worktree %s timeout",
  (operation) => {
    let finishGit: (() => void) | undefined;

    beforeEach(() => {
      finishGit = undefined;
      execFileMock.mockReset();
      execFileMock.mockImplementation(
        (
          _command: string,
          args: string[],
          _options: unknown,
          callback: (error: null, stdout: string, stderr: string) => void,
        ) => {
          if (args.includes("list")) callback(null, "", "");
          else finishGit = () => callback(null, "", "");
        },
      );
    });

    const work = (timeoutMs?: number) =>
      (operation === "create"
        ? create("/repo", { name: "test" }, timeoutMs)
        : pruneStale("/repo", timeoutMs)
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));

    it.each([undefined, 5_000, 60_000])(
      "uses the configured deadline (%s ms)",
      async (override) => {
        const timeoutMs = override ?? 30_000;
        const exit = await Effect.runPromise(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(work(override));
            yield* TestClock.adjust(Duration.millis(timeoutMs - 1));
            expect(finishGit).toBeDefined();
            expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
            yield* TestClock.adjust(Duration.millis(1));
            yield* Effect.yieldNow();
            expect(Option.isSome(yield* Fiber.poll(fiber))).toBe(true);
            return yield* Fiber.await(fiber);
          }).pipe(Effect.provide(TestContext.TestContext)),
        );

        if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") {
          throw new Error("Expected a worktree timeout failure");
        }
        expect(exit.cause.error).toBeInstanceOf(WorktreeTimeoutError);
        expect(exit.cause.error).toMatchObject({
          timeoutMs,
          path: "/repo",
          operation,
          message: `Worktree ${operation === "create" ? "creation" : "prune"} timed out after ${timeoutMs}ms`,
        });
      },
    );

    it("allows slow Git work to finish after the old 30-second limit", async () => {
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(work(60_000));
          yield* TestClock.adjust(Duration.millis(45_000));
          expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
          finishGit!();
          return yield* Fiber.await(fiber);
        }).pipe(Effect.provide(TestContext.TestContext)),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  },
);
