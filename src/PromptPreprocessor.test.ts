import {
  Duration,
  Effect,
  Exit,
  Layer,
  Ref,
  TestClock,
  TestContext,
} from "effect";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Display, type DisplayEntry, SilentDisplay } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { substitutePromptArgs } from "./PromptArgumentSubstitution.js";
import type { SandboxService } from "./SandboxFactory.js";
import { makeLocalSandbox } from "./testSandbox.js";
import { PromptError, PromptExpansionTimeoutError } from "./errors.js";

describe("PromptPreprocessor", () => {
  const setup = async () => {
    const sandboxDir = await realpath(
      await mkdtemp(join(tmpdir(), "preprocess-test-")),
    );
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(displayRef);
    const sandbox = makeLocalSandbox(sandboxDir);
    return { sandboxDir, sandbox, displayLayer, displayRef };
  };

  // Mirrors production: raw template goes through substitutePromptArgs first
  // (which marks template-authored shell blocks), then through preprocessPrompt.
  const run = async (
    prompt: string,
    sandbox: SandboxService,
    displayLayer: Layer.Layer<Display>,
    cwd: string,
  ) => {
    const marked = await Effect.runPromise(
      substitutePromptArgs(prompt, {}).pipe(Effect.provide(displayLayer)),
    );
    return Effect.runPromise(
      preprocessPrompt(marked, sandbox, cwd).pipe(Effect.provide(displayLayer)),
    );
  };

  it("passes through prompts with no !`command` expressions unchanged", async () => {
    const { sandboxDir, sandbox, displayLayer } = await setup();
    const prompt = "This is a plain prompt with no commands.\n\nJust text.";
    const result = await run(prompt, sandbox, displayLayer, sandboxDir);
    expect(result).toBe(prompt);
  });

  it("replaces a single !`command` with its stdout", async () => {
    const { sandboxDir, sandbox, displayLayer } = await setup();
    const prompt = "Here is the date: !`echo 2026-03-24`";
    const result = await run(prompt, sandbox, displayLayer, sandboxDir);
    expect(result).toBe("Here is the date: 2026-03-24");
  });

  it("replaces multiple !`command` expressions", async () => {
    const { sandboxDir, sandbox, displayLayer } = await setup();
    const prompt = "First: !`echo hello`\nSecond: !`echo world`";
    const result = await run(prompt, sandbox, displayLayer, sandboxDir);
    expect(result).toBe("First: hello\nSecond: world");
  });

  it("fails with PromptError on non-zero exit code and carries exitCode", async () => {
    const { sandboxDir, sandbox, displayLayer } = await setup();
    const marked = await Effect.runPromise(
      substitutePromptArgs("Output: !`exit 7`", {}).pipe(
        Effect.provide(displayLayer),
      ),
    );
    const result = await Effect.runPromise(
      preprocessPrompt(marked, sandbox, sandboxDir).pipe(
        Effect.flip,
        Effect.provide(displayLayer),
      ),
    );
    expect(result).toBeInstanceOf(PromptError);
    expect(result._tag).toBe("PromptError");
    expect(result.message).toContain("exit 7");
    expect(result.message).toContain("exited with code 7");
    if (result._tag !== "PromptError") throw new Error("unreachable");
    expect(result.exitCode).toBe(7);
  });

  it("runs commands with the provided cwd", async () => {
    const { sandboxDir, sandbox, displayLayer } = await setup();
    const prompt = "Dir: !`pwd`";
    const result = await run(prompt, sandbox, displayLayer, sandboxDir);
    expect(result).toBe(`Dir: ${sandboxDir}`);
  });

  it("runs multiple shell expressions in parallel", async () => {
    const { sandboxDir } = await setup();

    // Track start/end events to verify parallel execution
    const events: string[] = [];

    const spySandbox: SandboxService = {
      exec: (command, _options) =>
        Effect.gen(function* () {
          events.push(`start:${command}`);
          yield* Effect.yieldNow();
          events.push(`end:${command}`);
          if (command === "echo hello") {
            return { stdout: "hello\n", stderr: "", exitCode: 0 };
          }
          if (command === "echo world") {
            return { stdout: "world\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      copyIn: () => Effect.succeed(undefined as never),
      copyFileOut: () => Effect.succeed(undefined as never),
    };

    const displayLayer = SilentDisplay.layer(
      Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
    );

    const marked = await Effect.runPromise(
      substitutePromptArgs(
        "First: !`echo hello`\nSecond: !`echo world`",
        {},
      ).pipe(Effect.provide(displayLayer)),
    );
    const result = await Effect.runPromise(
      preprocessPrompt(marked, spySandbox, sandboxDir).pipe(
        Effect.provide(displayLayer),
      ),
    );

    expect(result).toBe("First: hello\nSecond: world");
    expect(events).toEqual([
      "start:echo hello",
      "start:echo world",
      "end:echo hello",
      "end:echo world",
    ]);
  });

  it("logs per-command token counts after shell expressions resolve", async () => {
    const { sandboxDir, sandbox, displayLayer, displayRef } = await setup();
    const prompt = "First: !`echo hello`\nSecond: !`echo world`";
    await run(prompt, sandbox, displayLayer, sandboxDir);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    const taskLogEntry = entries.find((e) => e._tag === "taskLog");
    expect(taskLogEntry).toBeDefined();
    if (taskLogEntry!._tag !== "taskLog") throw new Error("unreachable");
    const helloTokens = Math.ceil("hello".length / 4);
    const worldTokens = Math.ceil("world".length / 4);
    expect(taskLogEntry!.messages[0]).toBe(
      `echo hello → ~${helloTokens} tokens`,
    );
    expect(taskLogEntry!.messages[1]).toBe(
      `echo world → ~${worldTokens} tokens`,
    );
    expect(taskLogEntry!.messages).toHaveLength(2);
  });

  it("executes template shell blocks with {{KEY}} substituted into the command", async () => {
    const { sandboxDir, sandbox, displayLayer } = await setup();
    const rawTemplate = "Greeting: !`echo hello {{NAME}}`";
    const substituted = await Effect.runPromise(
      substitutePromptArgs(rawTemplate, { NAME: "world" }).pipe(
        Effect.provide(displayLayer),
      ),
    );
    const result = await Effect.runPromise(
      preprocessPrompt(substituted, sandbox, sandboxDir).pipe(
        Effect.provide(displayLayer),
      ),
    );
    expect(result).toBe("Greeting: hello world");
  });

  it("does not execute shell blocks that arrive via prompt argument substitution", async () => {
    const { sandboxDir, sandbox, displayLayer } = await setup();
    const rawTemplate = "Title: {{TITLE}}";
    const substituted = await Effect.runPromise(
      substitutePromptArgs(rawTemplate, {
        TITLE: "fixes !`rm -rf /` (do not run)",
      }).pipe(Effect.provide(displayLayer)),
    );
    const result = await Effect.runPromise(
      preprocessPrompt(substituted, sandbox, sandboxDir).pipe(
        Effect.provide(displayLayer),
      ),
    );
    expect(result).toContain("!`rm -rf /`");
  });

  it("strips marker characters smuggled through arg values so they cannot forge a shell block", async () => {
    const { sandboxDir, sandbox, displayLayer } = await setup();
    const rawTemplate = "Payload: {{DATA}}";
    const substituted = await Effect.runPromise(
      substitutePromptArgs(rawTemplate, {
        DATA: "!\x01`rm -rf /`",
      }).pipe(Effect.provide(displayLayer)),
    );
    const result = await Effect.runPromise(
      preprocessPrompt(substituted, sandbox, sandboxDir).pipe(
        Effect.provide(displayLayer),
      ),
    );
    expect(result).toBe("Payload: !`rm -rf /`");
  });

  it("fails with PromptExpansionTimeoutError carrying elapsedMs measured at the throw site", async () => {
    const { sandboxDir, displayLayer } = await setup();
    const hangingSandbox: SandboxService = {
      exec: () => Effect.never,
      copyIn: () => Effect.succeed(undefined as never),
      copyFileOut: () => Effect.succeed(undefined as never),
    };

    const marked = await Effect.runPromise(
      substitutePromptArgs("Hang: !`sleep forever`", {}).pipe(
        Effect.provide(displayLayer),
      ),
    );

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        preprocessPrompt(marked, hangingSandbox, sandboxDir).pipe(
          Effect.provide(displayLayer),
        ),
      );
      // Advance virtual clock past the 30s prompt-expansion timeout.
      yield* TestClock.adjust(Duration.millis(30_001));
      return yield* fiber.await;
    }).pipe(Effect.provide(TestContext.TestContext));

    const exit = await Effect.runPromise(program);

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") {
      throw new Error("Expected Fail cause");
    }
    const error = exit.cause.error;
    expect(error).toBeInstanceOf(PromptExpansionTimeoutError);
    if (!(error instanceof PromptExpansionTimeoutError)) {
      throw new Error("unreachable");
    }
    expect(error.expression).toBe("sleep forever");
    expect(error.timeoutMs).toBe(30_000);
    expect(error.elapsedMs).toBeGreaterThanOrEqual(30_000);
  });

  it("does not show taskLog when prompt has no commands", async () => {
    const { sandboxDir, sandbox, displayLayer, displayRef } = await setup();
    const prompt = "Just a plain prompt with no commands.";
    await run(prompt, sandbox, displayLayer, sandboxDir);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    expect(entries.filter((e) => e._tag === "taskLog")).toHaveLength(0);
  });
});
