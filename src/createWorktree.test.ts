import { exec, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createWorktree } from "./createWorktree.js";
import type {
  CreateWorktreeOptions,
  WorktreeRunOptions,
  WorktreeInteractiveOptions,
  WorktreeCreateSandboxOptions,
} from "./createWorktree.js";
import { claudeCode, codex } from "./AgentProvider.js";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type InteractiveExecOptions,
  type ExecResult,
  type SandboxProvider,
} from "./SandboxProvider.js";
import { encodeProjectPath } from "./SessionStore.js";
import { makeLocalSandbox } from "./testSandbox.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

describe("createWorktree", () => {
  it("creates a worktree with 'branch' strategy", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "test-branch" },
      cwd: hostDir,
    });

    try {
      expect(ws.worktreePath).toContain(".sandcastle/worktrees");
      expect(ws.branch).toBe("test-branch");
      expect(existsSync(ws.worktreePath)).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("creates a worktree with 'merge-to-head' strategy", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "merge-to-head" },
      cwd: hostDir,
    });

    try {
      expect(ws.worktreePath).toContain(".sandcastle/worktrees");
      expect(ws.branch).toMatch(/^sandcastle\//);
      expect(existsSync(ws.worktreePath)).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("creates a worktree with baseBranch forking from specified ref", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const { stdout: baseSha } = await execAsync("git rev-parse HEAD", {
      cwd: hostDir,
    });

    // Add a second commit so HEAD moves forward
    await commitFile(hostDir, "second.txt", "second", "second commit");

    const ws = await createWorktree({
      branchStrategy: {
        type: "branch",
        branch: "feature-from-base",
        baseBranch: baseSha.trim(),
      },
      cwd: hostDir,
    });

    try {
      expect(ws.branch).toBe("feature-from-base");

      // The worktree should be at the base commit, not HEAD
      const { stdout: worktreeHead } = await execAsync("git rev-parse HEAD", {
        cwd: ws.worktreePath,
      });
      expect(worktreeHead.trim()).toBe(baseSha.trim());
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("rejects 'head' branch strategy at the type level", () => {
    const _options: CreateWorktreeOptions = {
      // @ts-expect-error - head strategy should be a compile-time error
      branchStrategy: { type: "head" },
    };
  });

  it("does not accept signal option (compile-time check)", () => {
    const _options: CreateWorktreeOptions = {
      branchStrategy: { type: "branch", branch: "test" },
      // @ts-expect-error - signal should not be accepted on createWorktree
      signal: new AbortController().signal,
    };
  });

  it("copies files into the worktree with copyToWorktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    // Create a file to copy
    await writeFile(join(hostDir, "node_modules.txt"), "deps");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "copy-test" },
      copyToWorktree: ["node_modules.txt"],
      cwd: hostDir,
    });

    try {
      expect(existsSync(join(ws.worktreePath, "node_modules.txt"))).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("reuses existing clean worktree when called twice with the same branch", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws1 = await createWorktree({
      branchStrategy: { type: "branch", branch: "reuse-branch" },
      cwd: hostDir,
    });

    // Close the first handle (worktree is clean, so it gets removed)
    await ws1.close();

    // Re-create the branch so worktree collision can happen
    const ws1b = await createWorktree({
      branchStrategy: { type: "branch", branch: "reuse-branch" },
      cwd: hostDir,
    });

    // Now create a second handle while the first is still alive
    const ws2 = await createWorktree({
      branchStrategy: { type: "branch", branch: "reuse-branch" },
      cwd: hostDir,
    });

    expect(ws2.worktreePath).toBe(ws1b.worktreePath);
    expect(ws2.branch).toBe("reuse-branch");

    await ws1b.close();
    await rm(hostDir, { recursive: true, force: true });
  });

  it("reuses dirty worktree with a warning", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws1 = await createWorktree({
      branchStrategy: { type: "branch", branch: "dirty-branch" },
      cwd: hostDir,
    });

    // Make the worktree dirty
    await writeFile(join(ws1.worktreePath, "dirty.txt"), "uncommitted");

    const ws2 = await createWorktree({
      branchStrategy: { type: "branch", branch: "dirty-branch" },
      cwd: hostDir,
    });

    expect(ws2.worktreePath).toBe(ws1.worktreePath);

    // Clean up
    await rm(ws1.worktreePath, { recursive: true, force: true });
    await execAsync("git worktree prune", { cwd: hostDir });
    await rm(hostDir, { recursive: true, force: true });
  });

  it("close() removes worktree when clean", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "clean-close" },
      cwd: hostDir,
    });

    const worktreePath = ws.worktreePath;
    const result = await ws.close();

    expect(result.preservedWorktreePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("close() preserves worktree when dirty", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "dirty-close" },
      cwd: hostDir,
    });

    // Make worktree dirty
    await writeFile(join(ws.worktreePath, "dirty.txt"), "uncommitted");

    const result = await ws.close();

    expect(result.preservedWorktreePath).toBe(ws.worktreePath);
    expect(existsSync(ws.worktreePath)).toBe(true);

    // Clean up manually
    await rm(ws.worktreePath, { recursive: true, force: true });
    await execAsync("git worktree prune", { cwd: hostDir });
    await rm(hostDir, { recursive: true, force: true });
  });

  it("Symbol.asyncDispose works via await using", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let worktreePath: string;
    {
      await using ws = await createWorktree({
        branchStrategy: { type: "branch", branch: "dispose-test" },
        cwd: hostDir,
      });
      worktreePath = ws.worktreePath;
      expect(existsSync(worktreePath)).toBe(true);
    }
    expect(existsSync(worktreePath!)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("close() is idempotent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "idempotent-close" },
      cwd: hostDir,
    });

    const result1 = await ws.close();
    const result2 = await ws.close();

    expect(result1.preservedWorktreePath).toBeUndefined();
    expect(result2.preservedWorktreePath).toBeUndefined();
    await rm(hostDir, { recursive: true, force: true });
  });
});

describe("worktree.interactive()", () => {
  /**
   * Create a test bind-mount provider with a fake interactiveExec.
   */
  const makeTestProvider = (
    fakeInteractiveExec: (
      args: string[],
      opts: InteractiveExecOptions,
    ) => Promise<{ exitCode: number }>,
  ) =>
    createBindMountSandboxProvider({
      name: "test-interactive",
      create: async (options) => {
        const handle: BindMountSandboxHandle = {
          worktreePath: options.worktreePath,
          exec: async (command) => {
            const result = execSync(command, {
              cwd: options.worktreePath,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });
            return { stdout: result, stderr: "", exitCode: 0 };
          },
          interactiveExec: fakeInteractiveExec,
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {},
        };
        return handle;
      },
    });

  it("runs interactive session and returns result shape", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-interactive-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = makeTestProvider(async (_args, _opts) => {
      return { exitCode: 0 };
    });

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "interactive-test" },
      cwd: hostDir,
    });

    try {
      const result = await ws.interactive({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: provider,
        prompt: "test prompt",
      });

      expect(result).toHaveProperty("exitCode");
      expect(result).toHaveProperty("branch");
      expect(result).toHaveProperty("commits");
      expect(typeof result.branch).toBe("string");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("accepts explicit sandbox parameter", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-interactive-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const receivedArgs: string[] = [];
    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "sandbox-test" },
      cwd: hostDir,
    });

    try {
      const result = await ws.interactive({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: provider,
        prompt: "fix the bug",
      });

      expect(result.exitCode).toBe(0);
      expect(receivedArgs).toContain("fix the bug");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("worktree persists after interactive session completes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-interactive-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = makeTestProvider(async (_args, opts) => {
      // Make a commit during the session
      const cwd = opts.cwd!;
      execSync('echo "new content" > newfile.txt', { cwd });
      execSync("git add newfile.txt", { cwd });
      execSync('git commit -m "agent commit"', { cwd });
      return { exitCode: 0 };
    });

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "persist-test" },
      cwd: hostDir,
    });

    try {
      await ws.interactive({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: provider,
        prompt: "add a file",
      });

      // Worktree should still exist after interactive session
      expect(existsSync(ws.worktreePath)).toBe(true);
      // The commit should be in the worktree
      const log = execSync("git log --oneline -1", {
        cwd: ws.worktreePath,
        encoding: "utf-8",
      });
      expect(log).toContain("agent commit");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("pre-aborted signal rejects immediately without running agent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-interactive-abort-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let agentCalled = false;
    const provider = makeTestProvider(async () => {
      agentCalled = true;
      return { exitCode: 0 };
    });

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "interactive-abort-test" },
      cwd: hostDir,
    });

    try {
      const ac = new AbortController();
      ac.abort("pre-aborted-interactive");

      await expect(
        ws.interactive({
          agent: claudeCode("claude-opus-4-8"),
          sandbox: provider,
          prompt: "test prompt",
          signal: ac.signal,
        }),
      ).rejects.toBe("pre-aborted-interactive");

      expect(agentCalled).toBe(false);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("abort preserves worktree and handle remains usable", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-interactive-abort-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ac = new AbortController();
    ac.abort("abort-interactive");

    const provider = makeTestProvider(async () => ({ exitCode: 0 }));

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "interactive-abort-preserve" },
      cwd: hostDir,
    });

    try {
      // First call: aborted
      await expect(
        ws.interactive({
          agent: claudeCode("claude-opus-4-8"),
          sandbox: provider,
          prompt: "test",
          signal: ac.signal,
        }),
      ).rejects.toBe("abort-interactive");

      // Worktree preserved
      expect(existsSync(ws.worktreePath)).toBe(true);

      // Handle still usable
      const result = await ws.interactive({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: provider,
        prompt: "test again",
      });
      expect(result.exitCode).toBe(0);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("signal option has correct type on WorktreeInteractiveOptions", () => {
    const _options: WorktreeInteractiveOptions = {
      agent: claudeCode("claude-opus-4-8"),
      prompt: "test",
      signal: new AbortController().signal,
    };
  });

  it("returns InteractiveResult with commits from the session", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-interactive-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = makeTestProvider(async (_args, opts) => {
      const cwd = opts.cwd!;
      execSync('echo "content" > file.txt', { cwd });
      execSync("git add file.txt", { cwd });
      execSync('git commit -m "a commit"', { cwd });
      return { exitCode: 42 };
    });

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "result-test" },
      cwd: hostDir,
    });

    try {
      const result = await ws.interactive({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: provider,
        prompt: "test",
      });

      expect(result.exitCode).toBe(42);
      expect(result.commits.length).toBe(1);
      expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.branch).toBe("result-test");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });
});

/** Format a mock agent result as stream-json lines (mimicking Claude's output) */
const toStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: output }] },
    }),
  );
  lines.push(JSON.stringify({ type: "result", result: output }));
  return lines.join("\n");
};

/**
 * Format a mock codex result as JSON stream lines including a `turn.completed`
 * usage event so the Orchestrator surfaces usage via `streamUsage`.
 */
const toCodexStreamJsonWithUsage = (
  output: string,
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  },
): string => {
  const lines: string[] = [
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: output },
    }),
    JSON.stringify({ type: "turn.completed", usage }),
  ];
  return lines.join("\n");
};

describe("worktree.run()", () => {
  /**
   * Create a test bind-mount provider that intercepts agent commands
   * and runs a mock behavior, while passing other commands through.
   */
  const makeRunTestProvider = (
    mockAgentBehavior: (cwd: string) => Promise<string> = async () =>
      "mock output",
  ) =>
    createBindMountSandboxProvider({
      name: "test-run",
      create: async (options) => {
        const handle: BindMountSandboxHandle = {
          worktreePath: options.worktreePath,
          exec: async (
            command: string,
            execOptions?: {
              cwd?: string;
              onLine?: (line: string) => void;
              sudo?: boolean;
            },
          ): Promise<ExecResult> => {
            const cwd = execOptions?.cwd ?? options.worktreePath;
            // Intercept agent commands
            if (command.startsWith("claude ")) {
              const output = await mockAgentBehavior(cwd);
              const streamOutput = toStreamJson(output);
              if (execOptions?.onLine) {
                for (const line of streamOutput.split("\n")) {
                  execOptions.onLine(line);
                }
              }
              return { stdout: streamOutput, stderr: "", exitCode: 0 };
            }
            if (command.startsWith("codex ")) {
              const output = await mockAgentBehavior(cwd);
              const streamOutput = toCodexStreamJsonWithUsage(output, {
                input_tokens: 50000,
                cached_input_tokens: 0,
                output_tokens: 100,
              });
              if (execOptions?.onLine) {
                for (const line of streamOutput.split("\n")) {
                  execOptions.onLine(line);
                }
              }
              return { stdout: streamOutput, stderr: "", exitCode: 0 };
            }
            // Pass through other commands
            const result = execSync(command, {
              cwd,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });
            return { stdout: result, stderr: "", exitCode: 0 };
          },
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {},
        };
        return handle;
      },
    });

  it("runs agent and returns WorktreeRunResult", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = makeRunTestProvider();

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "run-test" },
      cwd: hostDir,
    });

    try {
      const result = await ws.run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox,
        prompt: "do something",
        maxIterations: 1,
      });

      expect(result.iterations.length).toBe(1);
      expect(typeof result.stdout).toBe("string");
      expect(Array.isArray(result.commits)).toBe(true);
      expect(result.branch).toBe("run-test");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("emits 'Context window: NNNk' line when an iteration has usage", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-ctxwin-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");
    const logPath = join(hostDir, "ctxwin.log");

    const sandbox = makeRunTestProvider();

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "ctxwin-test" },
      cwd: hostDir,
    });

    try {
      const result = await ws.run({
        agent: codex("gpt-test"),
        sandbox,
        prompt: "do something",
        maxIterations: 1,
        logging: { type: "file", path: logPath },
      });

      // Sanity-check: orchestrator surfaced usage on the iteration.
      expect(result.iterations[0]!.usage).toBeDefined();

      const log = await readFile(logPath, "utf-8");
      expect(log).toContain("Context window: 50k");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("captures Claude session and emits 'Context window' from parsed usage (regression: #717)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-claude-cap-"));
    const hostProjectsDir = await mkdtemp(
      join(tmpdir(), "ws-run-claude-host-projects-"),
    );
    const sandboxProjectsDir = await mkdtemp(
      join(tmpdir(), "ws-run-claude-sb-projects-"),
    );
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");
    const logPath = join(hostDir, "ctxwin.log");
    const mockSessionId = "wsrun-claude-cap-1";

    // Bind-mount provider whose handle exposes filesystem-backed copyFileIn/
    // copyFileOut so AgentSessionStorage.captureToHost works. The exec layer
    // intercepts `claude ...`, writes a fake session JSONL into the sandbox's
    // projects directory, and streams a stub session_id.
    const sandbox = createBindMountSandboxProvider({
      name: "test-claude-cap",
      create: async (options) => {
        const handle: BindMountSandboxHandle = {
          worktreePath: options.worktreePath,
          exec: async (command, execOptions) => {
            const cwd = execOptions?.cwd ?? options.worktreePath;
            if (command.startsWith("claude ")) {
              const encoded = encodeProjectPath(cwd);
              const sessionsDir = join(sandboxProjectsDir, encoded);
              await mkdir(sessionsDir, { recursive: true });
              await writeFile(
                join(sessionsDir, `${mockSessionId}.jsonl`),
                [
                  JSON.stringify({
                    type: "system",
                    subtype: "init",
                    session_id: mockSessionId,
                    cwd,
                  }),
                  JSON.stringify({
                    type: "assistant",
                    message: {
                      model: "claude-opus-4-8",
                      usage: {
                        input_tokens: 50000,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                        output_tokens: 100,
                      },
                    },
                    cwd,
                  }),
                ].join("\n"),
              );
              const streamLines = [
                JSON.stringify({
                  type: "system",
                  subtype: "init",
                  session_id: mockSessionId,
                }),
                JSON.stringify({
                  type: "assistant",
                  message: { content: [{ type: "text", text: "ok" }] },
                }),
                JSON.stringify({ type: "result", result: "ok" }),
              ].join("\n");
              if (execOptions?.onLine) {
                for (const line of streamLines.split("\n")) {
                  execOptions.onLine(line);
                }
              }
              return { stdout: streamLines, stderr: "", exitCode: 0 };
            }
            try {
              const result = execSync(command, {
                cwd,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
              });
              return { stdout: result, stderr: "", exitCode: 0 };
            } catch (e: any) {
              return {
                stdout: e?.stdout?.toString() ?? "",
                stderr: e?.stderr?.toString() ?? "",
                exitCode:
                  typeof e?.status === "number" && e.status !== null
                    ? e.status
                    : 1,
              };
            }
          },
          copyFileIn: async (hostPath, sandboxPath) => {
            await mkdir(dirname(sandboxPath), { recursive: true });
            await copyFile(hostPath, sandboxPath);
          },
          copyFileOut: async (sandboxPath, hostPath) => {
            await mkdir(dirname(hostPath), { recursive: true });
            await copyFile(sandboxPath, hostPath);
          },
          close: async () => {},
        };
        return handle;
      },
    });

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "ctxwin-claude-test" },
      cwd: hostDir,
    });

    try {
      const result = await ws.run({
        agent: claudeCode("test-model", {
          sessionStorage: { hostProjectsDir, sandboxProjectsDir },
        }),
        sandbox,
        prompt: "do something",
        maxIterations: 1,
        logging: { type: "file", path: logPath },
      });

      expect(result.iterations[0]!.usage).toEqual({
        inputTokens: 50000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 100,
      });
      expect(result.iterations[0]!.sessionFilePath).toBeDefined();

      const log = await readFile(logPath, "utf-8");
      expect(log).toContain("Context window: 50k");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
      await rm(hostProjectsDir, { recursive: true, force: true });
      await rm(sandboxProjectsDir, { recursive: true, force: true });
    }
  });

  it("worktree persists after run completes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = makeRunTestProvider(async (cwd) => {
      execSync('echo "agent file" > agent.txt', { cwd });
      execSync("git add agent.txt", { cwd });
      execSync('git commit -m "agent commit"', { cwd });
      return "done";
    });

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "persist-run-test" },
      cwd: hostDir,
    });

    try {
      await ws.run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox,
        prompt: "create a file",
        maxIterations: 1,
      });

      // Worktree should still exist after run
      expect(existsSync(ws.worktreePath)).toBe(true);
      // The commit should be in the worktree
      const log = execSync("git log --oneline -1", {
        cwd: ws.worktreePath,
        encoding: "utf-8",
      });
      expect(log).toContain("agent commit");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("returns commits made during the run", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = makeRunTestProvider(async (cwd) => {
      execSync('echo "new file" > created.txt', { cwd });
      execSync("git add created.txt", { cwd });
      execSync('git commit -m "test commit"', { cwd });
      return "done";
    });

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "commits-run-test" },
      cwd: hostDir,
    });

    try {
      const result = await ws.run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox,
        prompt: "create a file",
        maxIterations: 1,
      });

      expect(result.commits.length).toBeGreaterThanOrEqual(1);
      expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.branch).toBe("commits-run-test");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("merge-to-head: agent commits advance host's current branch", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-mth-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const { stdout: hostHeadBefore } = await execAsync("git rev-parse HEAD", {
      cwd: hostDir,
    });

    const sandbox = makeRunTestProvider(async (cwd) => {
      execSync('echo "agent file" > agent.txt', { cwd });
      execSync("git add agent.txt", { cwd });
      execSync('git commit -m "agent commit"', { cwd });
      return "done";
    });

    const ws = await createWorktree({
      branchStrategy: { type: "merge-to-head" },
      cwd: hostDir,
    });

    try {
      const result = await ws.run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox,
        prompt: "create a file",
        maxIterations: 1,
      });

      // The result branch is the host's current branch (main), not the temp branch
      expect(result.branch).toBe("main");
      expect(result.commits.length).toBeGreaterThanOrEqual(1);

      // Host's main has advanced to include the agent's commit
      const { stdout: hostHeadAfter } = await execAsync("git rev-parse HEAD", {
        cwd: hostDir,
      });
      expect(hostHeadAfter.trim()).not.toBe(hostHeadBefore.trim());

      // The commit is reachable from main's HEAD
      const { stdout: log } = await execAsync("git log --format=%s -n 1 HEAD", {
        cwd: hostDir,
      });
      expect(log.trim()).toBe("agent commit");

      // The worktree's source branch must survive so the worktree handle is reusable
      expect(existsSync(ws.worktreePath)).toBe(true);
      const { stdout: worktreeBranch } = await execAsync(
        "git rev-parse --abbrev-ref HEAD",
        { cwd: ws.worktreePath },
      );
      expect(worktreeBranch.trim()).toBe(ws.branch);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("merge-to-head: two sequential run() calls both land on host", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-mth-2x-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let iter = 0;
    const sandbox = makeRunTestProvider(async (cwd) => {
      iter += 1;
      const name = `iter${iter}.txt`;
      execSync(`echo "iter ${iter}" > ${name}`, { cwd });
      execSync(`git add ${name}`, { cwd });
      execSync(`git commit -m "agent commit ${iter}"`, { cwd });
      return "done";
    });

    const ws = await createWorktree({
      branchStrategy: { type: "merge-to-head" },
      cwd: hostDir,
    });

    try {
      await ws.run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox,
        prompt: "first",
        maxIterations: 1,
      });

      // Second run() reuses the same worktree handle — the source branch must
      // still exist on disk for the iteration to find HEAD inside the sandbox.
      await ws.run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox,
        prompt: "second",
        maxIterations: 1,
      });

      const { stdout: log } = await execAsync("git log --format=%s -n 2 HEAD", {
        cwd: hostDir,
      });
      const messages = log.trim().split("\n");
      expect(messages).toEqual(["agent commit 2", "agent commit 1"]);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox is required (type error if omitted)", () => {
    // This test validates at the type level — sandbox is required in WorktreeRunOptions
    const _options = {
      agent: claudeCode("claude-opus-4-8"),
      prompt: "test",
      // @ts-expect-error — sandbox is required
    } satisfies WorktreeRunOptions;
  });

  it("pre-aborted signal rejects immediately without running agent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-abort-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let agentCalled = false;
    const sandbox = makeRunTestProvider(async () => {
      agentCalled = true;
      return "should not run";
    });

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "abort-pre-test" },
      cwd: hostDir,
    });

    try {
      const ac = new AbortController();
      ac.abort("pre-aborted");

      await expect(
        ws.run({
          agent: claudeCode("claude-opus-4-8"),
          sandbox,
          prompt: "do something",
          signal: ac.signal,
        }),
      ).rejects.toBe("pre-aborted");

      expect(agentCalled).toBe(false);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("abort preserves worktree on disk", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-abort-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ac = new AbortController();
    const sandbox = makeRunTestProvider(async () => {
      // Abort mid-execution
      ac.abort("cancel-mid-run");
      // Return something so the mock doesn't hang
      return "partial output";
    });

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "abort-preserve-test" },
      cwd: hostDir,
    });

    try {
      await expect(
        ws.run({
          agent: claudeCode("claude-opus-4-8"),
          sandbox,
          prompt: "do something",
          signal: ac.signal,
        }),
      ).rejects.toBe("cancel-mid-run");

      // Worktree should still exist after abort
      expect(existsSync(ws.worktreePath)).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("handle is still usable after abort", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-abort-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ac = new AbortController();
    ac.abort("first-abort");

    const sandbox = makeRunTestProvider(async () => "done");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "abort-reuse-test" },
      cwd: hostDir,
    });

    try {
      // First call: aborted
      await expect(
        ws.run({
          agent: claudeCode("claude-opus-4-8"),
          sandbox,
          prompt: "do something",
          signal: ac.signal,
        }),
      ).rejects.toBe("first-abort");

      // Second call: should succeed without signal
      const result = await ws.run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox,
        prompt: "do something else",
      });

      expect(result.iterations.length).toBe(1);
      expect(result.branch).toBe("abort-reuse-test");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("signal option has the correct type on WorktreeRunOptions", () => {
    const _options: WorktreeRunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
      signal: new AbortController().signal,
    };
  });
});

/** Dummy sandbox provider used to satisfy the required `sandbox` field in test mode. */
const testSandbox: SandboxProvider = createBindMountSandboxProvider({
  name: "test",
  create: async (options) => ({
    worktreePath: options.worktreePath,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    copyFileIn: async () => {},
    copyFileOut: async () => {},
    close: async () => {},
  }),
});

describe("worktree.createSandbox()", () => {
  it("creates a sandbox with branch and worktreePath from the worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-sandbox-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "ws-sandbox-test" },
      cwd: hostDir,
    });

    try {
      const sandbox = await ws.createSandbox({
        sandbox: testSandbox,
        _test: {
          buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
        },
      });

      try {
        expect(sandbox.branch).toBe("ws-sandbox-test");
        expect(sandbox.worktreePath).toBe(ws.worktreePath);
      } finally {
        await sandbox.close();
      }
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.close() tears down container but leaves worktree intact", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-sandbox-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "split-ownership" },
      cwd: hostDir,
    });

    try {
      const sandbox = await ws.createSandbox({
        sandbox: testSandbox,
        _test: {
          buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
        },
      });

      const closeResult = await sandbox.close();

      // Sandbox close should NOT report preserved worktree (it doesn't own it)
      expect(closeResult.preservedWorktreePath).toBeUndefined();
      // Worktree should still exist — worktree owns it
      expect(existsSync(ws.worktreePath)).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("ws.close() cleans up worktree after sandbox.close()", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-sandbox-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "ws-close-after-sandbox" },
      cwd: hostDir,
    });

    const worktreePath = ws.worktreePath;

    const sandbox = await ws.createSandbox({
      sandbox: testSandbox,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    await sandbox.close();
    expect(existsSync(worktreePath)).toBe(true);

    const wsCloseResult = await ws.close();
    expect(wsCloseResult.preservedWorktreePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);

    await rm(hostDir, { recursive: true, force: true });
  });

  it("multiple sandboxes can be created sequentially from the same worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-sandbox-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "sequential-sandbox" },
      cwd: hostDir,
    });

    try {
      // First sandbox
      const sandbox1 = await ws.createSandbox({
        sandbox: testSandbox,
        _test: {
          buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
        },
      });
      expect(sandbox1.branch).toBe("sequential-sandbox");
      await sandbox1.close();

      // Second sandbox — should work on same worktree
      const sandbox2 = await ws.createSandbox({
        sandbox: testSandbox,
        _test: {
          buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
        },
      });
      expect(sandbox2.branch).toBe("sequential-sandbox");
      expect(sandbox2.worktreePath).toBe(ws.worktreePath);
      await sandbox2.close();

      expect(existsSync(ws.worktreePath)).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("does not accept branch options", () => {
    const _options: WorktreeCreateSandboxOptions = {
      sandbox: testSandbox,
      // @ts-expect-error - branch should not be accepted
      branch: "should-not-work",
    };
  });
});
