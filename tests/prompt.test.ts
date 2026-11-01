import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BindMountSandboxHandle, RunOptions } from "@ai-hero/sandcastle";
import {
  claudeCode,
  createBindMountSandboxProvider,
  run,
} from "@ai-hero/sandcastle";

// Where run() gets its prompt from: inline `prompt`, or `promptFile` read from
// disk. A scripted sandbox records what the agent is handed on stdin.

const DONE = JSON.stringify({
  type: "result",
  subtype: "success",
  result: "<promise>COMPLETE</promise>",
});

const recordingSandbox = (received: string[]) =>
  createBindMountSandboxProvider({
    name: "recording",
    create: async (options): Promise<BindMountSandboxHandle> => ({
      worktreePath: options.worktreePath,
      exec: async (_command, execOptions) => {
        if (execOptions?.stdin !== undefined) {
          received.push(execOptions.stdin);
        }
        execOptions?.onLine?.(DONE);
        return { stdout: DONE, stderr: "", exitCode: 0 };
      },
      copyFileIn: async () => undefined,
      copyFileOut: async () => undefined,
      close: async () => undefined,
    }),
  });

describe("run() prompt sources", () => {
  let repo = "";
  let received: string[] = [];

  const runWith = async (prompt: Pick<RunOptions, "prompt" | "promptFile">) =>
    run({
      agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
      sandbox: recordingSandbox(received),
      cwd: repo,
      branchStrategy: { type: "head" },
      logging: { type: "file", path: path.join(repo, "run.log") },
      ...prompt,
    });

  beforeEach(() => {
    received = [];
    repo = mkdtempSync(path.join(tmpdir(), "e2e-prompt-"));
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

  it("hands an inline prompt to the agent", async () => {
    await runWith({ prompt: "do some work" });

    expect(received).toStrictEqual(["do some work"]);
  });

  it("hands the contents of promptFile to the agent", async () => {
    const promptFile = path.join(repo, "custom-prompt.md");
    writeFileSync(promptFile, "prompt from file");

    await runWith({ promptFile });

    expect(received).toStrictEqual(["prompt from file"]);
  });

  it("rejects both prompt and promptFile", async () => {
    await expect(
      runWith({ prompt: "inline", promptFile: "/some/file.md" }),
    ).rejects.toThrow("Cannot provide both prompt and promptFile");
    expect(received).toStrictEqual([]);
  });

  it("rejects neither prompt nor promptFile, naming both options", async () => {
    await expect(runWith({})).rejects.toThrow(
      "Must provide either prompt or promptFile. Pass prompt: '...' or promptFile: './.sandcastle/prompt.md' to run().",
    );
    expect(received).toStrictEqual([]);
  });

  it("rejects a promptFile that can't be read, naming the file", async () => {
    const promptFile = path.join(repo, "missing.md");

    await expect(runWith({ promptFile })).rejects.toThrow(
      `Failed to read prompt from ${promptFile}: `,
    );
    expect(received).toStrictEqual([]);
  });
});
