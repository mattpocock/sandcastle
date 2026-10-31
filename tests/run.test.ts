import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BindMountSandboxHandle } from "@ai-hero/sandcastle";
import {
  claudeCode,
  createBindMountSandboxProvider,
  run,
} from "@ai-hero/sandcastle";

// A real Claude Code agent factory, run in a scripted sandbox: the sandbox's
// exec plays back the stream-json Claude Code would print, so the whole run()
// flow (prompt, stream parsing, completion signal, result) runs for real.

const streamJson = (...events: readonly unknown[]): string[] =>
  events.map((event) => JSON.stringify(event));

const scriptedSandbox = (lines: readonly string[]) =>
  createBindMountSandboxProvider({
    name: "scripted",
    create: async (options): Promise<BindMountSandboxHandle> => ({
      worktreePath: options.worktreePath,
      exec: async (_command, execOptions) => {
        for (const line of lines) {
          execOptions?.onLine?.(line);
        }
        return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
      },
      copyFileIn: async () => undefined,
      copyFileOut: async () => undefined,
      close: async () => undefined,
    }),
  });

describe("run() with a scripted Claude Code sandbox", () => {
  let repo = "";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "e2e-run-"));
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

  it("returns the agent's session, output and completion signal", async () => {
    const sandbox = scriptedSandbox(
      streamJson(
        { type: "system", subtype: "init", session_id: "sess-e2e-1" },
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "All done. <promise>COMPLETE</promise>" },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "All done. <promise>COMPLETE</promise>",
        },
      ),
    );

    const result = await run({
      agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
      sandbox,
      cwd: repo,
      prompt: "Finish the task.",
      branchStrategy: { type: "head" },
      logging: { type: "file", path: path.join(repo, "run.log") },
    });

    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]?.sessionId).toBe("sess-e2e-1");
    expect(result.stdout).toContain("All done.");
    expect(result.commits).toStrictEqual([]);
  });
});
