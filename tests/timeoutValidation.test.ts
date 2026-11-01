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

// run() rejects a zero, negative, NaN or non-number timeout up front, naming
// the option, before any sandbox is created: such a timeout would otherwise
// fire before the agent's first output with a misleading error.

const COMPLETE = "Done. <promise>COMPLETE</promise>";

const STREAM = [
  { type: "system", subtype: "init", session_id: "sess-timeouts" },
  {
    type: "assistant",
    message: { content: [{ type: "text", text: COMPLETE }] },
  },
  { type: "result", subtype: "success", result: COMPLETE },
].map((event) => JSON.stringify(event));

describe("run() timeout validation", () => {
  let repo = "";
  let sandboxesCreated = 0;

  const sandbox = createBindMountSandboxProvider({
    name: "scripted",
    create: async (options): Promise<BindMountSandboxHandle> => {
      sandboxesCreated++;
      return {
        worktreePath: options.worktreePath,
        exec: async (_command, execOptions) => {
          for (const line of STREAM) {
            execOptions?.onLine?.(line);
          }
          return { stdout: STREAM.join("\n"), stderr: "", exitCode: 0 };
        },
        copyFileIn: async () => undefined,
        copyFileOut: async () => undefined,
        close: async () => undefined,
      };
    },
  });

  beforeEach(() => {
    sandboxesCreated = 0;
    repo = mkdtempSync(path.join(tmpdir(), "e2e-timeouts-"));
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

  type TimeoutFields = Pick<
    RunOptions,
    "idleTimeoutSeconds" | "completionTimeoutSeconds" | "timeouts"
  >;

  const runWith = async (timeouts: TimeoutFields) =>
    run({
      agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
      sandbox,
      cwd: repo,
      prompt: "Finish the task.",
      branchStrategy: { type: "head" },
      logging: { type: "file", path: path.join(repo, "run.log") },
      ...timeouts,
    });

  it("runs when every timeout is unset", async () => {
    const result = await runWith({});
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("runs when every timeout is positive", async () => {
    const result = await runWith({
      idleTimeoutSeconds: 0.1,
      completionTimeoutSeconds: 5,
      timeouts: {
        copyToWorktreeMs: 1,
        gitSetupMs: 10_000,
        commitCollectionMs: 30_000,
        mergeToHostMs: 30_000,
      },
    });
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it.each([0, -1, Number.NaN])(
    "rejects idleTimeoutSeconds: %s, naming the option",
    async (value) => {
      await expect(runWith({ idleTimeoutSeconds: value })).rejects.toThrow(
        `idleTimeoutSeconds must be a positive number of seconds. Received: ${value}`,
      );
    },
  );

  it.each([0, -1, Number.NaN])(
    "rejects completionTimeoutSeconds: %s, naming the option",
    async (value) => {
      await expect(
        runWith({ completionTimeoutSeconds: value }),
      ).rejects.toThrow(
        `completionTimeoutSeconds must be a positive number of seconds. Received: ${value}`,
      );
    },
  );

  it.each(
    (
      [
        "copyToWorktreeMs",
        "gitSetupMs",
        "commitCollectionMs",
        "mergeToHostMs",
      ] as const
    ).flatMap((key) =>
      [0, -1, Number.NaN].map((value) => [key, value] as const),
    ),
  )("rejects timeouts.%s: %s, naming the option", async (key, value) => {
    await expect(runWith({ timeouts: { [key]: value } })).rejects.toThrow(
      `timeouts.${key} must be a positive number of milliseconds. Received: ${value}`,
    );
  });

  it("rejects a non-number from an untyped caller", async () => {
    // What a JavaScript caller passing a string ends up sending.
    const untyped: TimeoutFields = Object.fromEntries([
      ["idleTimeoutSeconds", "30"],
    ]);
    await expect(runWith(untyped)).rejects.toThrow(
      "idleTimeoutSeconds must be a positive number of seconds. Received: '30'",
    );
  });

  it("rejects before creating a sandbox", async () => {
    await runWith({ idleTimeoutSeconds: 0 }).catch(() => undefined);
    expect(sandboxesCreated).toBe(0);
  });
});
