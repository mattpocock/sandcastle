import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BindMountSandboxHandle,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  claudeCode,
  createBindMountSandboxProvider,
  Output,
  run,
} from "@ai-hero/sandcastle";

// Claude Code can continue one reply across several assistant messages, and
// its final `result` event repeats only the last one. run() reads the whole
// ordered assistant text, so a <tag>…</tag> split across messages is still
// found, and `stdout` holds that text once, without the repeated snapshot
// (#970). A final result that isn't a repeat of the streamed text is used
// as it is.

/** Accepts any value as-is. */
const passthrough: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
};

/**
 * A sandbox whose Claude Code streams one assistant message per entry of
 * `messages`, then a final result of `result`. With `hang`, the agent never
 * exits after its last line.
 */
const replying = (
  messages: readonly string[],
  result: string,
  hang: boolean,
): SandboxProvider =>
  createBindMountSandboxProvider({
    name: "scripted",
    create: async (options): Promise<BindMountSandboxHandle> => {
      const lines = [
        { type: "system", subtype: "init", session_id: "sess" },
        ...messages.map((text) => ({
          type: "assistant",
          message: { content: [{ type: "text", text }] },
        })),
        { type: "result", subtype: "success", result },
      ].map((event) => JSON.stringify(event));
      return {
        worktreePath: options.worktreePath,
        exec: async (command, execOptions) => {
          if (!command.startsWith("claude ")) {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          for (const line of lines) {
            execOptions?.onLine?.(line);
          }
          if (hang) {
            await new Promise<never>(() => {});
          }
          return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
        },
        copyFileIn: async () => undefined,
        copyFileOut: async (_sandboxPath, hostPath) => {
          mkdirSync(path.dirname(hostPath), { recursive: true });
          writeFileSync(hostPath, "");
        },
        close: async () => undefined,
      };
    },
  });

describe("run() output across assistant messages", () => {
  let repo = "";

  beforeEach(() => {
    repo = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "e2e-continuation-")),
    );
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# repo\n");
    git("add", ".");
    git("commit", "-m", "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const baseOptions = () => ({
    agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
    cwd: repo,
    prompt: "Answer inside <result> tags.",
    branchStrategy: { type: "head" } as const,
    logging: { type: "file", path: path.join(repo, "run.log") } as const,
  });

  const splitHead = 'Here it is. <result>{"items":["alpha",';
  const splitTail = '"beta"]}</result>';

  it("Output.object parses JSON whose tag spans two messages", async () => {
    const result = await run({
      ...baseOptions(),
      sandbox: replying([splitHead, splitTail], splitTail, false),
      output: Output.object({
        tag: "result",
        schema: passthrough,
        maxRetries: 0,
      }),
    });

    expect(result.output).toStrictEqual({ items: ["alpha", "beta"] });
  }, 30_000);

  it("Output.string reads a tag split across three messages", async () => {
    const last = "three</result>";
    const result = await run({
      ...baseOptions(),
      sandbox: replying(["<result>one ", "two ", last], last, false),
      output: Output.string({ tag: "result", maxRetries: 0 }),
    });

    expect(result.output).toBe("one two three");
  }, 30_000);

  it("returns the streamed text once in stdout, without the repeated final message", async () => {
    const result = await run({
      ...baseOptions(),
      sandbox: replying([splitHead, splitTail], splitTail, false),
    });

    expect(result.stdout).toBe(splitHead + splitTail);
  }, 30_000);

  it("returns a final result that doesn't repeat the streamed text as it is", async () => {
    const result = await run({
      ...baseOptions(),
      sandbox: replying(["Working on it."], "All done.", false),
    });

    expect(result.stdout).toBe("All done.");
  }, 30_000);

  it("keeps every message when the agent hangs after its completion signal", async () => {
    const last = "true}</result><promise>COMPLETE</promise>";
    const result = await run({
      ...baseOptions(),
      sandbox: replying(['<result>{"done":', last], last, true),
      completionSignal: "<promise>COMPLETE</promise>",
      completionTimeoutSeconds: 0.2,
      output: Output.object({
        tag: "result",
        schema: passthrough,
        maxRetries: 0,
      }),
    });

    expect(result.output).toStrictEqual({ done: true });
  }, 30_000);
});
