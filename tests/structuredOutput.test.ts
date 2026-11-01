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
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import type {
  BindMountSandboxHandle,
  RunResult,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  claudeCode,
  claudeHostSessionPath,
  createBindMountSandboxProvider,
  Output,
  run,
  StructuredOutputError,
} from "@ai-hero/sandcastle";

// run({ output }) reads the agent's final reply for the last <tag>…</tag>.
// Output.object JSON-parses it (inside an optional Markdown fence) and
// validates it against a Standard Schema; Output.string trims it. When it
// can't, run() rejects with a StructuredOutputError carrying what a caller
// needs to recover: the raw match, the cause, the commits and branch, a
// preserved worktree and the session to resume.

const SESSION_ID = "sess-structured";

/** Accepts any value as-is. */
const passthrough: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
};

/** Accepts objects only. */
const objectsOnly: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) =>
      typeof value === "object" && value !== null
        ? { value }
        : { issues: [{ message: "Expected an object" }] },
  },
};

/** Validates asynchronously, accepting any value. */
const asyncPassthrough: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: async (value: unknown) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      return { value };
    },
  },
};

/** Rejects every value with `message`. */
const alwaysFail = (message: string): StandardSchemaV1<unknown, never> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: () => ({ issues: [{ message }] }),
  },
});

describe("run() structured output", () => {
  let repo = "";

  beforeEach(() => {
    // The real path: on Windows, tmpdir() can be an 8.3 short name.
    repo = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "e2e-structured-")),
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

  /**
   * A sandbox whose Claude Code replies with `reply` as its final result.
   * `onAgent` runs first, in the host worktree, as the agent's own work.
   */
  const replying = (
    reply: string,
    onAgent: (hostWorktree: string) => void = () => undefined,
  ): SandboxProvider =>
    createBindMountSandboxProvider({
      name: "scripted",
      create: async (options): Promise<BindMountSandboxHandle> => {
        const hostWorktree = options.mounts[0]?.hostPath ?? "";
        const lines = [
          { type: "system", subtype: "init", session_id: SESSION_ID },
          {
            type: "assistant",
            message: { content: [{ type: "text", text: reply }] },
          },
          { type: "result", subtype: "success", result: reply },
        ].map((event) => JSON.stringify(event));
        return {
          worktreePath: options.worktreePath,
          exec: async (command, execOptions) => {
            if (!command.startsWith("claude ")) {
              return { stdout: "", stderr: "", exitCode: 0 };
            }
            onAgent(hostWorktree);
            for (const line of lines) {
              execOptions?.onLine?.(line);
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

  const runObject = async (
    reply: string,
    schema: StandardSchemaV1<unknown, unknown> = passthrough,
  ): Promise<RunResult & { output: unknown }> =>
    run({
      agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
      sandbox: replying(reply),
      cwd: repo,
      prompt: "Answer inside <result> tags.",
      branchStrategy: { type: "head" },
      logging: { type: "file", path: path.join(repo, "run.log") },
      output: Output.object({ tag: "result", schema, maxRetries: 0 }),
    });

  const runString = async (reply: string): Promise<string> => {
    const result = await run({
      agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
      sandbox: replying(reply),
      cwd: repo,
      prompt: "Summarise inside <summary> tags.",
      branchStrategy: { type: "head" },
      logging: { type: "file", path: path.join(repo, "run.log") },
      output: Output.string({ tag: "summary", maxRetries: 0 }),
    });
    return result.output;
  };

  /** The StructuredOutputError `promise` rejects with. */
  const rejectionOf = async (
    promise: Promise<unknown>,
  ): Promise<StructuredOutputError> => {
    try {
      await promise;
    } catch (error) {
      assert.instanceOf(error, StructuredOutputError);
      return error;
    }
    return expect.unreachable("run() should have rejected");
  };

  describe("Output.object", () => {
    it("parses the JSON inside the tag", async () => {
      const result = await runObject('Done. <result>{"answer": 42}</result>');
      expect(result.output).toStrictEqual({ answer: 42 });
    });

    it("uses the last occurrence of the tag", async () => {
      const result = await runObject(
        '<result>{"v": 1}</result> then <result>{"v": 2}</result>',
      );
      expect(result.output).toStrictEqual({ v: 2 });
    });

    it("unwraps a ```json fence inside the tag", async () => {
      const result = await runObject(
        '<result>\n```json\n{"fenced": true}\n```\n</result>',
      );
      expect(result.output).toStrictEqual({ fenced: true });
    });

    it("unwraps a bare ``` fence inside the tag", async () => {
      const result = await runObject(
        '<result>\n```\n{"bare": true}\n```\n</result>',
      );
      expect(result.output).toStrictEqual({ bare: true });
    });

    it("ignores whitespace around the JSON", async () => {
      const result = await runObject('<result>  \n  {"a": 1}  \n  </result>');
      expect(result.output).toStrictEqual({ a: 1 });
    });

    it("parses nested objects and arrays", async () => {
      const result = await runObject(
        '<result>{"nested": {"deep": true}, "list": [1, 2, 3]}</result>',
      );
      expect(result.output).toStrictEqual({
        nested: { deep: true },
        list: [1, 2, 3],
      });
    });

    it("accepts a schema that validates asynchronously", async () => {
      const result = await runObject(
        '<result>{"x": 99}</result>',
        asyncPassthrough,
      );
      expect(result.output).toStrictEqual({ x: 99 });
    });

    it("rejects a missing tag, with no raw match", async () => {
      const error = await rejectionOf(runObject("No structured output here."));
      expect({
        message: error.message,
        tag: error.tag,
        rawMatched: error.rawMatched,
      }).toStrictEqual({
        message: "Structured output tag <result> not found in agent output",
        tag: "result",
        rawMatched: undefined,
      });
    });

    it("rejects invalid JSON, with the raw match and the parse error", async () => {
      const error = await rejectionOf(runObject("<result>not json</result>"));
      expect({
        message: error.message,
        rawMatched: error.rawMatched,
        causeIsSyntaxError: error.cause instanceof SyntaxError,
      }).toStrictEqual({
        message: "Structured output tag <result> contains invalid JSON",
        rawMatched: "not json",
        causeIsSyntaxError: true,
      });
    });

    it("rejects a schema failure, with the schema's issues as the cause", async () => {
      const error = await rejectionOf(
        runObject('<result>{"answer": 42}</result>', alwaysFail("bad")),
      );
      expect({
        message: error.message,
        rawMatched: error.rawMatched,
        cause: error.cause,
      }).toStrictEqual({
        message: "Structured output tag <result> failed schema validation",
        rawMatched: '{"answer": 42}',
        cause: [{ message: "bad" }],
      });
    });

    it("validates the parsed JSON against the schema", async () => {
      const error = await rejectionOf(
        runObject('<result>"not an object"</result>', objectsOnly),
      );
      expect(error.cause).toStrictEqual([{ message: "Expected an object" }]);
    });
  });

  describe("Output.string", () => {
    it("returns the tag's content, trimmed", async () => {
      await expect(
        runString("<summary>  The summary.  </summary>"),
      ).resolves.toBe("The summary.");
    });

    it("uses the last occurrence of the tag", async () => {
      await expect(
        runString("<summary>first</summary> <summary>second</summary>"),
      ).resolves.toBe("second");
    });

    it("keeps multiline content", async () => {
      await expect(
        runString("<summary>\n  line one\n  line two\n</summary>"),
      ).resolves.toBe("line one\n  line two");
    });

    it("does not parse JSON", async () => {
      await expect(runString('<summary>{"a": 1}</summary>')).resolves.toBe(
        '{"a": 1}',
      );
    });

    it("rejects a missing tag", async () => {
      const error = await rejectionOf(runString("nothing here"));
      expect({ message: error.message, tag: error.tag }).toStrictEqual({
        message: "Structured output tag <summary> not found in agent output",
        tag: "summary",
      });
    });
  });

  describe("StructuredOutputError", () => {
    it("is an Error named StructuredOutputError", async () => {
      const error = await rejectionOf(runObject("no tag"));
      expect({
        isError: error instanceof Error,
        name: error.name,
      }).toStrictEqual({ isError: true, name: "StructuredOutputError" });
    });

    it("carries the run's commits and branch", async () => {
      const error = await rejectionOf(
        run({
          agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
          sandbox: replying("no tag", (worktree) => {
            writeFileSync(path.join(worktree, "work.txt"), "done\n");
            execFileSync("git", ["add", "."], { cwd: worktree });
            execFileSync("git", ["commit", "-q", "-m", "work"], {
              cwd: worktree,
            });
          }),
          cwd: repo,
          prompt: "Answer inside <result> tags.",
          branchStrategy: { type: "branch", branch: "agent" },
          logging: { type: "file", path: path.join(repo, "run.log") },
          output: Output.object({
            tag: "result",
            schema: passthrough,
            maxRetries: 0,
          }),
        }),
      );
      const sha = execFileSync("git", ["rev-parse", "agent"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      expect({ commits: error.commits, branch: error.branch }).toStrictEqual({
        commits: [{ sha }],
        branch: "agent",
      });
    });

    it("has the session id but no session file when sessions are not captured", async () => {
      const error = await rejectionOf(runObject("no tag"));
      expect({
        sessionId: error.sessionId,
        sessionFilePath: error.sessionFilePath,
      }).toStrictEqual({ sessionId: SESSION_ID, sessionFilePath: undefined });
    });

    it("carries the captured session id and file path", async () => {
      const projects = path.join(repo, ".claude-projects");
      const error = await rejectionOf(
        run({
          agent: claudeCode("claude-opus-4-8", {
            sessionStorage: { hostProjectsDir: projects },
          }),
          sandbox: replying("no tag"),
          cwd: repo,
          prompt: "Answer inside <result> tags.",
          branchStrategy: { type: "head" },
          logging: { type: "file", path: path.join(repo, "run.log") },
          output: Output.object({
            tag: "result",
            schema: passthrough,
            maxRetries: 0,
          }),
        }),
      );
      expect({
        sessionId: error.sessionId,
        sessionFilePath: error.sessionFilePath,
      }).toStrictEqual({
        sessionId: SESSION_ID,
        sessionFilePath: claudeHostSessionPath(repo, SESSION_ID, projects),
      });
    });

    it("carries the preserved worktree when the agent left changes", async () => {
      const error = await rejectionOf(
        run({
          agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
          sandbox: replying("no tag", (worktree) => {
            writeFileSync(path.join(worktree, "draft.txt"), "unsaved\n");
          }),
          cwd: repo,
          prompt: "Answer inside <result> tags.",
          branchStrategy: { type: "branch", branch: "agent" },
          logging: { type: "file", path: path.join(repo, "run.log") },
          output: Output.object({
            tag: "result",
            schema: passthrough,
            maxRetries: 0,
          }),
        }),
      );
      expect({
        preserved: error.preservedWorktreePath,
        branch: error.branch,
      }).toStrictEqual({
        preserved: path.join(repo, ".sandcastle", "worktrees", "agent"),
        branch: "agent",
      });
    });
  });
});
