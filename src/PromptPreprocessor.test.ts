import { Effect, Layer, Ref } from "effect";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DisplayEntry, SilentDisplay } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { Sandbox } from "./SandboxFactory.js";
import { makeLocalSandboxLayer } from "./testSandbox.js";
import { PromptError } from "./errors.js";

describe("PromptPreprocessor", () => {
  const setup = async () => {
    const sandboxDir = await mkdtemp(join(tmpdir(), "preprocess-test-"));
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const layer = Layer.merge(
      makeLocalSandboxLayer(sandboxDir),
      SilentDisplay.layer(displayRef),
    );
    return { sandboxDir, layer, displayRef };
  };

  const run = (
    prompt: string,
    layer: Awaited<ReturnType<typeof setup>>["layer"],
    cwd: string,
  ) =>
    Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => preprocessPrompt(prompt, s, cwd)),
        Effect.provide(layer),
      ),
    );

  it("passes through prompts with no !`command` expressions unchanged", async () => {
    const { sandboxDir, layer } = await setup();
    const prompt = "This is a plain prompt with no commands.\n\nJust text.";
    const result = await run(prompt, layer, sandboxDir);
    expect(result).toBe(prompt);
  });

  it("replaces a single !`command` with its stdout", async () => {
    const { sandboxDir, layer } = await setup();
    const prompt = "Here is the date: !`echo 2026-03-24`";
    const result = await run(prompt, layer, sandboxDir);
    expect(result).toBe("Here is the date: 2026-03-24");
  });

  it("replaces multiple !`command` expressions", async () => {
    const { sandboxDir, layer } = await setup();
    const prompt = "First: !`echo hello`\nSecond: !`echo world`";
    const result = await run(prompt, layer, sandboxDir);
    expect(result).toBe("First: hello\nSecond: world");
  });

  it("fails with PromptError on non-zero exit code", async () => {
    const { sandboxDir, layer } = await setup();
    const prompt = "Output: !`exit 1`";
    const result = await Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => preprocessPrompt(prompt, s, sandboxDir)),
        Effect.flip,
        Effect.provide(layer),
      ),
    );
    expect(result).toBeInstanceOf(PromptError);
    expect(result._tag).toBe("PromptError");
    expect(result.message).toContain("exit 1");
    expect(result.message).toContain("exited with code 1");
  });

  it("runs commands with the provided cwd", async () => {
    const { sandboxDir, layer } = await setup();
    const prompt = "Dir: !`pwd`";
    const result = await run(prompt, layer, sandboxDir);
    expect(result).toBe(`Dir: ${sandboxDir}`);
  });

  it("runs multiple shell expressions in parallel", async () => {
    const { sandboxDir, layer } = await setup();

    // Track start/end events to verify parallel execution
    const events: string[] = [];

    const spySandboxLayer = Layer.succeed(Sandbox, {
      exec: (command, options) =>
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
    });

    const spyLayer = Layer.merge(
      spySandboxLayer,
      SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
    );

    const result = await Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) =>
          preprocessPrompt(
            "First: !`echo hello`\nSecond: !`echo world`",
            s,
            sandboxDir,
          ),
        ),
        Effect.provide(spyLayer),
      ),
    );

    expect(result).toBe("First: hello\nSecond: world");
    // With parallel execution, both commands should start before either ends
    expect(events).toEqual([
      "start:echo hello",
      "start:echo world",
      "end:echo hello",
      "end:echo world",
    ]);
  });

  it("does not show taskLog when prompt has no commands", async () => {
    const { sandboxDir, layer, displayRef } = await setup();
    const prompt = "Just a plain prompt with no commands.";
    await run(prompt, layer, sandboxDir);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    expect(entries.filter((e) => e._tag === "taskLog")).toHaveLength(0);
  });

  it("includes a token count message in the taskLog after resolving shell expressions", async () => {
    const { sandboxDir, layer, displayRef } = await setup();
    // "hello" is 5 chars → estimateTokens = ceil(5/4) = 2
    const prompt = "Result: !`echo hello`";
    await run(prompt, layer, sandboxDir);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    const taskLogEntry = entries.find((e) => e._tag === "taskLog");
    expect(taskLogEntry).toBeDefined();
    if (taskLogEntry?._tag === "taskLog") {
      const tokenMsg = taskLogEntry.messages.find((m) =>
        m.includes("tokens from shell expressions"),
      );
      expect(tokenMsg).toBeDefined();
      expect(tokenMsg).toMatch(/^~\d+ tokens from shell expressions$/);
    }
  });

  it("token count covers all shell expression outputs combined", async () => {
    const { sandboxDir, layer, displayRef } = await setup();
    // "hello" (5) + "world" (5) = 10 chars → ceil(5/4) + ceil(5/4) = 2 + 2 = 4 tokens
    const prompt = "A: !`echo hello`\nB: !`echo world`";
    await run(prompt, layer, sandboxDir);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    const taskLogEntry = entries.find((e) => e._tag === "taskLog");
    expect(taskLogEntry).toBeDefined();
    if (taskLogEntry?._tag === "taskLog") {
      const tokenMsg = taskLogEntry.messages.find((m) =>
        m.includes("tokens from shell expressions"),
      );
      expect(tokenMsg).toBeDefined();
      expect(tokenMsg).toBe("~4 tokens from shell expressions");
    }
  });
});
