import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: [string, string][] = vi.hoisted(() => []);

vi.mock("@clack/prompts", () => {
  const record = (kind: string) => (msg: string) => {
    calls.push([kind, msg]);
  };
  return {
    intro: record("intro"),
    note: record("note"),
    log: {
      message: record("message"),
      step: record("step"),
      info: record("info"),
      success: record("success"),
      warning: record("warning"),
      error: record("error"),
    },
  };
});

const { ClackDisplay, Display } = await import("./Display.js");

const strip = (s: string) => s.replaceAll(/\u001B\[[0-9;]*m/g, "");

const runWith = (
  program: Effect.Effect<void, never, InstanceType<typeof Display>>,
) =>
  Effect.runPromise(
    program.pipe(Effect.provide(ClackDisplay.layer)) as Effect.Effect<void>,
  );

describe("ClackDisplay - textChunk", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("never prints a word split across messages", async () => {
    await runWith(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.textChunk("I'll run the five comm");
        yield* d.textChunk("ands in parallel since they're independent.\n");
      }),
    );

    expect(calls).toEqual([
      [
        "message",
        "I'll run the five commands in parallel since they're independent.",
      ],
    ]);
  });

  it("flushes a pending partial line before a tool call, keeping order", async () => {
    await runWith(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.textChunk("Let me read ");
        yield* d.textChunk("the file.");
        yield* d.toolCall("Read", "src/hello.ts");
        yield* d.textChunk("Done.");
        yield* d.status("Agent stopped", "info");
      }),
    );

    expect(calls.map(([k, m]) => [k, strip(m)])).toEqual([
      ["message", "Let me read the file."],
      ["step", "Read(src/hello.ts)"],
      ["message", "Done."],
      ["info", "Agent stopped"],
    ]);
  });

  it("prints complete lines as they arrive and holds the tail", async () => {
    await runWith(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.textChunk("First line.\nSecond li");
        expect(calls).toEqual([["message", "First line."]]);
        yield* d.textChunk("ne.\n");
      }),
    );

    expect(calls).toEqual([
      ["message", "First line."],
      ["message", "Second line."],
    ]);
  });

  it("does not print blank lines at paragraph breaks", async () => {
    await runWith(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.textChunk("Para one.\n\n");
        yield* d.textChunk("Para two.");
      }),
    );

    expect(calls).toEqual([
      ["message", "Para one."],
      ["message", "Para two."],
    ]);
  });

  it("flushes a pending partial line when the display is released", async () => {
    await runWith(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.textChunk("Trailing text with no newline");
      }),
    );

    expect(calls).toEqual([["message", "Trailing text with no newline"]]);
  });
});
