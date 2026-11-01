import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentStreamEvent,
  BindMountSandboxHandle,
} from "@ai-hero/sandcastle";
import { createBindMountSandboxProvider, pi, run } from "@ai-hero/sandcastle";

// Pi streams its reply a token at a time. run() buffers those deltas and
// reports them as readable multi-word text chunks: a chunk ends at a newline,
// at the end of a sentence (". ", "! ", "? "), past ~80 characters, before a
// tool call, after ~50ms with no new text, and when the agent finishes.

/** A step the scripted Pi plays: a text delta, a tool call, or a pause. */
type Step =
  | { readonly delta: string }
  | { readonly tool: string }
  | { readonly waitMs: number };

const piLine = (step: { delta: string } | { tool: string }): string =>
  JSON.stringify(
    "delta" in step
      ? {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: step.delta },
        }
      : {
          type: "tool_execution_start",
          toolName: step.tool,
          args: { command: "ls" },
        },
  );

describe("run() text chunks from a streaming agent", () => {
  let repo = "";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "e2e-chunks-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# repo\n");
    git("add", ".");
    git("commit", "-m", "init");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(repo, { recursive: true, force: true });
  });

  /**
   * Runs a scripted Pi through run() and returns the stream events it
   * reported. `wait` performs each pause.
   */
  const play = async (
    steps: readonly Step[],
    wait: (ms: number) => Promise<void> = async (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  ): Promise<AgentStreamEvent[]> => {
    const events: AgentStreamEvent[] = [];
    const sandbox = createBindMountSandboxProvider({
      name: "scripted-pi",
      create: async (options): Promise<BindMountSandboxHandle> => ({
        worktreePath: options.worktreePath,
        exec: async (_command, execOptions) => {
          // Strictly in order: each step waits for the one before.
          await steps.reduce<Promise<void>>(async (previous, step) => {
            await previous;
            if ("waitMs" in step) {
              await wait(step.waitMs);
              return;
            }
            execOptions?.onLine?.(piLine(step));
          }, Promise.resolve());
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        copyFileIn: async () => undefined,
        copyFileOut: async () => undefined,
        close: async () => undefined,
      }),
    });
    await run({
      agent: pi("test-model", { captureSessions: false }),
      sandbox,
      cwd: repo,
      prompt: "Go.",
      branchStrategy: { type: "head" },
      logging: {
        type: "file",
        path: path.join(repo, "run.log"),
        onAgentStreamEvent: (event) => {
          events.push(event);
        },
      },
    });
    return events;
  };

  const texts = (events: readonly AgentStreamEvent[]): string[] =>
    events.flatMap((e) => (e.type === "text" ? [e.message] : []));

  /** Text chunks and tool-call names, in the order they were reported. */
  const textsAndToolCalls = (events: readonly AgentStreamEvent[]): string[] =>
    events.flatMap((e) => {
      if (e.type === "raw") {
        return [];
      }
      return [e.type === "text" ? e.message : e.name];
    });

  it("ends a chunk at a newline", async () => {
    const events = await play([{ delta: "Hello world\n" }, { delta: "next" }]);
    expect(texts(events)).toStrictEqual(["Hello world\n", "next"]);
  });

  it.each(["Hello. ", "Hello! ", "Hello? "])(
    "ends a chunk at a sentence boundary: %j",
    async (sentence) => {
      const events = await play([{ delta: sentence }, { delta: "next" }]);
      expect(texts(events)).toStrictEqual([sentence, "next"]);
    },
  );

  it("does not end a chunk at punctuation without a following space", async () => {
    const events = await play([{ delta: "End." }, { delta: "next" }]);
    expect(texts(events)).toStrictEqual(["End.next"]);
  });

  it("ends a chunk once it passes the length threshold", async () => {
    const long = "a".repeat(90);
    const events = await play([{ delta: long }, { delta: "next" }]);
    expect(texts(events)).toStrictEqual([long, "next"]);
  });

  it("joins small deltas into one chunk", async () => {
    const events = await play([
      { delta: "Hel" },
      { delta: "lo" },
      { delta: " world" },
    ]);
    expect(texts(events)).toStrictEqual(["Hello world"]);
  });

  it("joins deltas across sentence boundaries into whole sentences", async () => {
    const events = await play([
      { delta: "First sentence. " },
      { delta: "Second" },
      { delta: " sentence.\n" },
    ]);
    expect(texts(events)).toStrictEqual([
      "First sentence. ",
      "Second sentence.\n",
    ]);
  });

  it("reports a chunk once, when a newline and a sentence end coincide", async () => {
    const events = await play([{ delta: "Done.\n" }]);
    expect(texts(events)).toStrictEqual(["Done.\n"]);
  });

  it("ignores empty deltas", async () => {
    const events = await play([{ delta: "" }, { delta: "" }]);
    expect(texts(events)).toStrictEqual([]);
  });

  it("ends a chunk before a tool call", async () => {
    const events = await play([
      { delta: "Let me look" },
      { tool: "bash" },
      { delta: "Found it" },
    ]);
    expect(textsAndToolCalls(events)).toStrictEqual([
      "Let me look",
      "Bash",
      "Found it",
    ]);
  });

  it("reports no empty chunk for a tool call with no text before it", async () => {
    const events = await play([{ tool: "bash" }]);
    expect(texts(events)).toStrictEqual([]);
  });

  describe("with a controlled clock", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    const tick = async (ms: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ms);
    };

    it("ends a chunk after 50ms with no new text", async () => {
      const events = await play(
        [{ delta: "Hello" }, { waitMs: 50 }, { delta: " world" }],
        tick,
      );
      expect(texts(events)).toStrictEqual(["Hello", " world"]);
    });

    it("keeps a chunk open while text keeps arriving within 50ms", async () => {
      const events = await play(
        [
          { delta: "Hello" },
          { waitMs: 30 },
          { delta: " world" },
          { waitMs: 30 },
          { delta: "!" },
        ],
        tick,
      );
      expect(texts(events)).toStrictEqual(["Hello world!"]);
    });

    it("reports a chunk ended at a boundary only once", async () => {
      const events = await play(
        [{ delta: "Hello.\n" }, { waitMs: 100 }, { delta: "next" }],
        tick,
      );
      expect(texts(events)).toStrictEqual(["Hello.\n", "next"]);
    });

    it("reports a chunk ended at a tool call only once", async () => {
      const events = await play(
        [{ delta: "Hello" }, { tool: "bash" }, { waitMs: 100 }],
        tick,
      );
      expect(texts(events)).toStrictEqual(["Hello"]);
    });
  });
});
