import { exec } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { claudeCode, codex, pi } from "./AgentProvider.js";
import { createSandbox, type CreateSandboxOptions } from "./createSandbox.js";
import type { SandboxService } from "./SandboxFactory.js";
import {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
  type BindMountSandboxHandle,
} from "./SandboxProvider.js";
import { encodeProjectPath } from "./SessionStore.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import { makeLocalSandbox } from "./testSandbox.js";

/** Dummy sandbox provider used to satisfy the required `sandbox` field in test mode. */
const testSandbox = createBindMountSandboxProvider({
  name: "test",
  create: async () => ({
    worktreePath: "/home/agent/workspace",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    copyFileIn: async () => {},
    copyFileOut: async () => {},
    close: async () => {},
  }),
});

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

const testProvider = claudeCode("test-model");
const testPiProvider = pi("test-model");

/** Format a mock pi agent result as stream-json lines */
const toPiStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: output },
    }),
  );
  lines.push(
    JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: output }],
        },
      ],
    }),
  );
  return lines.join("\n");
};

/** Known agent command prefixes and their stream formatters */
const AGENT_PREFIXES: { prefix: string; toStream: (o: string) => string }[] = [
  { prefix: "claude ", toStream: toStreamJson },
  { prefix: "pi ", toStream: toPiStreamJson },
];

/**
 * Format a mock codex agent result as JSON stream lines, optionally including
 * a `turn.completed` usage event so the Orchestrator can surface usage data
 * via `streamUsage` (no session capture required).
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

/** Mock sandbox that intercepts `codex` commands and emits stream usage. */
const makeMockCodexLayerWithUsage = (
  sandboxDir: string,
  output: string,
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  },
): SandboxService => {
  const real = makeLocalSandbox(sandboxDir);
  return {
    exec: (command, options) => {
      if (command.startsWith("codex ")) {
        const streamOutput = toCodexStreamJsonWithUsage(output, usage);
        if (options?.onLine) {
          const onLine = options.onLine;
          return Effect.gen(function* () {
            for (const line of streamOutput.split("\n")) {
              onLine(line);
            }
            return { stdout: streamOutput, stderr: "", exitCode: 0 };
          });
        }
        return Effect.succeed({
          stdout: streamOutput,
          stderr: "",
          exitCode: 0,
        });
      }
      return real.exec(command, options);
    },
    copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
    copyFileOut: (sandboxPath, hostPath) =>
      real.copyFileOut(sandboxPath, hostPath),
  };
};

/**
 * Create a mock sandbox layer that intercepts agent commands and runs a
 * mock script instead. All other commands pass through to the local sandbox.
 */
const makeMockAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): SandboxService => {
  const real = makeLocalSandbox(sandboxDir);

  const matchAgent = (command: string) =>
    AGENT_PREFIXES.find((a) => command.startsWith(a.prefix));

  return {
    exec: (command, options) => {
      const agent = matchAgent(command);
      if (agent && options?.onLine) {
        const onLine = options.onLine;
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          const streamOutput = agent.toStream(output);
          for (const line of streamOutput.split("\n")) {
            onLine(line);
          }
          return { stdout: streamOutput, stderr: "", exitCode: 0 };
        });
      }
      if (agent) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          return { stdout: output, stderr: "", exitCode: 0 };
        });
      }
      return real.exec(command, options);
    },
    copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
    copyFileOut: (sandboxPath, hostPath) =>
      real.copyFileOut(sandboxPath, hostPath),
  };
};

/**
 * Create a mock isolated sandbox provider that intercepts agent commands.
 * Uses testIsolated() as a base and wraps exec to intercept claude/pi commands.
 */
const makeMockIsolatedProvider = (
  mockAgentBehavior: (cwd: string) => Promise<string> = async () =>
    "mock output",
) => {
  const base = testIsolated();
  return createIsolatedSandboxProvider({
    name: "mock-isolated",
    create: async (opts) => {
      const handle = await base.create(opts);
      return {
        ...handle,
        exec: async (command: string, options?: any) => {
          const agent = AGENT_PREFIXES.find((a) =>
            command.startsWith(a.prefix),
          );
          if (agent && options?.onLine) {
            const cwd = options?.cwd ?? handle.worktreePath;
            const output = await mockAgentBehavior(cwd);
            const streamOutput = agent.toStream(output);
            for (const line of streamOutput.split("\n")) {
              options.onLine(line);
            }
            return { stdout: streamOutput, stderr: "", exitCode: 0 };
          }
          if (agent) {
            const cwd = options?.cwd ?? handle.worktreePath;
            const output = await mockAgentBehavior(cwd);
            return { stdout: output, stderr: "", exitCode: 0 };
          }
          return handle.exec(command, options);
        },
      };
    },
  });
};

describe("createSandbox", () => {
  it("creates a sandbox with branch and worktreePath properties", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      expect(sandbox.branch).toBe("test-branch");
      expect(sandbox.worktreePath).toContain(".sandcastle/worktrees");
      expect(existsSync(sandbox.worktreePath)).toBe(true);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() invokes agent and returns SandboxRunResult", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-run-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    try {
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "do something",
        maxIterations: 1,
      });

      expect(result.iterations.length).toBe(1);
      expect(typeof result.stdout).toBe("string");
      expect(Array.isArray(result.commits)).toBe(true);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() emits 'Context window: NNNk' line when an iteration has usage", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");
    const logPath = join(hostDir, "ctxwin.log");

    const sandbox = await createSandbox({
      branch: "ctxwin-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockCodexLayerWithUsage(sandboxDir, "ok", {
            input_tokens: 50000,
            cached_input_tokens: 0,
            output_tokens: 100,
          }),
      },
    });

    try {
      const result = await sandbox.run({
        agent: codex("gpt-test"),
        prompt: "do something",
        maxIterations: 1,
        logging: { type: "file", path: logPath },
      });

      // Sanity-check: orchestrator surfaced usage on the iteration.
      expect(result.iterations[0]!.usage).toBeDefined();

      const log = await readFile(logPath, "utf-8");
      expect(log).toContain("Context window: 50k");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() captures Claude session and emits 'Context window' from parsed usage (regression: #717)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-claude-cap-"));
    const hostProjectsDir = await mkdtemp(
      join(tmpdir(), "sandbox-claude-host-projects-"),
    );
    const sandboxProjectsDir = await mkdtemp(
      join(tmpdir(), "sandbox-claude-sb-projects-"),
    );
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");
    const logPath = join(hostDir, "ctxwin.log");
    const mockSessionId = "createSandbox-cap-session-1";

    const sandboxBaseDir = mkdtempSync(join(tmpdir(), "sandbox-claude-sb-"));

    // Fake bind-mount handle whose copyFileOut/copyFileIn are filesystem copies.
    // captureToHost reads the session JSONL out of the sandbox via this handle.
    const fakeHandle: BindMountSandboxHandle = {
      worktreePath: sandboxBaseDir,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
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

    const provider = claudeCode("test-model", {
      sessionStorage: { hostProjectsDir, sandboxProjectsDir },
    });

    // Build a sandbox layer that intercepts `claude ...` and writes a fake
    // session JSONL containing a usage block. The orchestrator parses the
    // captured JSONL via parseSessionUsage and surfaces it as iteration usage.
    const buildSandbox = (sandboxDir: string): SandboxService => {
      const real = makeLocalSandbox(sandboxDir);
      return {
        exec: (command, options) => {
          if (command.startsWith("claude ") && options?.onLine) {
            const onLine = options.onLine;
            return Effect.gen(function* () {
              const cwd = options?.cwd ?? sandboxDir;
              const encoded = encodeProjectPath(cwd);
              const sessionsDir = join(sandboxProjectsDir, encoded);
              yield* Effect.promise(async () => {
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
              });
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
              for (const line of streamLines.split("\n")) {
                onLine(line);
              }
              return { stdout: streamLines, stderr: "", exitCode: 0 };
            });
          }
          return real.exec(command, options);
        },
        copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) =>
          real.copyFileOut(sandboxPath, hostPath),
      };
    };

    const sandbox = await createSandbox({
      branch: "ctxwin-claude-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox,
        bindMountHandle: fakeHandle,
      },
    });

    try {
      const result = await sandbox.run({
        agent: provider,
        prompt: "do something",
        maxIterations: 1,
        logging: { type: "file", path: logPath },
      });

      // Usage was parsed out of the captured session JSONL.
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
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
      await rm(hostProjectsDir, { recursive: true, force: true });
      await rm(sandboxProjectsDir, { recursive: true, force: true });
      await rm(sandboxBaseDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() rejects resumeSession with maxIterations > 1", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-resume-validate-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "resume-validate",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "ok"),
      },
    });

    try {
      await expect(
        sandbox.run({
          agent: testProvider,
          prompt: "do something",
          maxIterations: 2,
          resumeSession: "abc-123",
        }),
      ).rejects.toThrow(
        "resumeSession cannot be combined with maxIterations > 1",
      );

      await expect(
        sandbox.run({
          agent: testProvider,
          prompt: "do something",
          forkSession: true,
        }),
      ).rejects.toThrow("forkSession requires resumeSession");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run().resume() reuses the captured session in the same warm sandbox", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-resume-flow-"));
    const hostProjectsDir = await mkdtemp(
      join(tmpdir(), "sandbox-resume-host-projects-"),
    );
    const sandboxProjectsDir = await mkdtemp(
      join(tmpdir(), "sandbox-resume-sb-projects-"),
    );
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");
    const mockSessionId = "resume-sandbox-session-1";
    const sandboxBaseDir = mkdtempSync(join(tmpdir(), "sandbox-resume-sb-"));

    const fakeHandle: BindMountSandboxHandle = {
      worktreePath: sandboxBaseDir,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
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

    const capturedCommands: string[] = [];

    // Mock agent: writes a session JSONL on every call, and records the
    // command so we can verify `--resume <id>` is forwarded on the resume
    // call. The second invocation's session id matches the first so the
    // resume can be detected without depending on agent CLI parsing.
    const buildSandbox = (sandboxDir: string): SandboxService => {
      const real = makeLocalSandbox(sandboxDir);
      return {
        exec: (command, options) => {
          if (command.startsWith("claude ") && options?.onLine) {
            capturedCommands.push(command);
            const onLine = options.onLine;
            return Effect.gen(function* () {
              const cwd = options?.cwd ?? sandboxDir;
              const encoded = encodeProjectPath(cwd);
              const sessionsDir = join(sandboxProjectsDir, encoded);
              yield* Effect.promise(async () => {
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
                          input_tokens: 100,
                          cache_creation_input_tokens: 0,
                          cache_read_input_tokens: 0,
                          output_tokens: 50,
                        },
                      },
                      cwd,
                    }),
                  ].join("\n"),
                );
              });
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
              for (const line of streamLines.split("\n")) {
                onLine(line);
              }
              return { stdout: streamLines, stderr: "", exitCode: 0 };
            });
          }
          return real.exec(command, options);
        },
        copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) =>
          real.copyFileOut(sandboxPath, hostPath),
      };
    };

    const sandbox = await createSandbox({
      branch: "resume-flow",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox,
        bindMountHandle: fakeHandle,
      },
    });

    try {
      const first = await sandbox.run({
        agent: claudeCode("test-model", {
          sessionStorage: { hostProjectsDir, sandboxProjectsDir },
        }),
        prompt: "do something",
        maxIterations: 1,
      });

      expect(first.iterations[0]!.sessionId).toBe(mockSessionId);
      expect(typeof first.resume).toBe("function");
      expect(typeof first.fork).toBe("function");

      const second = await first.resume!("now do something else");

      // The second iteration's agent command must include --resume <sid>.
      expect(capturedCommands.length).toBe(2);
      expect(capturedCommands[1]).toContain(`--resume '${mockSessionId}'`);
      // Resume runs exactly one iteration.
      expect(second.iterations.length).toBe(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
      await rm(hostProjectsDir, { recursive: true, force: true });
      await rm(sandboxProjectsDir, { recursive: true, force: true });
      await rm(sandboxBaseDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() appends raw stdout to the same log file when logging.verbose is true", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-verbose-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");
    const logPath = join(hostDir, "verbose.log");

    // Use a mock that emits both a recognised stream-JSON line and a line
    // parseStreamLine drops (unknown tool) so we can verify ALL stdout
    // makes it to the log file.
    const droppedToolLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "TotallyUnknownTool",
            input: { foo: "bar" },
          },
        ],
      },
    });
    const recognisedLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });

    const sandbox = await createSandbox({
      branch: "verbose-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => {
          const real = makeLocalSandbox(sandboxDir);
          return {
            exec: (command, options) => {
              if (command.startsWith("claude ") && options?.onLine) {
                const onLine = options.onLine;
                return Effect.gen(function* () {
                  for (const line of [droppedToolLine, recognisedLine]) {
                    onLine(line);
                  }
                  return {
                    stdout: [droppedToolLine, recognisedLine].join("\n"),
                    stderr: "",
                    exitCode: 0,
                  };
                });
              }
              return real.exec(command, options);
            },
            copyIn: real.copyIn,
            copyFileOut: real.copyFileOut,
          };
        },
      },
    });

    try {
      await sandbox.run({
        agent: testProvider,
        prompt: "do something",
        maxIterations: 1,
        logging: { type: "file", path: logPath, verbose: true },
      });

      const log = await readFile(logPath, "utf-8");
      expect(log).toContain(droppedToolLine);
      expect(log).toContain(recognisedLine);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() does NOT append raw stdout to the log file when verbose is false/unset", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-verbose-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");
    const logPath = join(hostDir, "verbose-off.log");

    // Same dropped-tool line as the verbose-on test. With verbose unset it
    // must NOT appear in the log file (parseStreamLine drops it and only
    // the human-readable output reaches the file).
    const droppedToolLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "TotallyUnknownTool",
            input: { foo: "bar" },
          },
        ],
      },
    });
    const recognisedLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });

    const sandbox = await createSandbox({
      branch: "verbose-off-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => {
          const real = makeLocalSandbox(sandboxDir);
          return {
            exec: (command, options) => {
              if (command.startsWith("claude ") && options?.onLine) {
                const onLine = options.onLine;
                return Effect.gen(function* () {
                  for (const line of [droppedToolLine, recognisedLine]) {
                    onLine(line);
                  }
                  return {
                    stdout: [droppedToolLine, recognisedLine].join("\n"),
                    stderr: "",
                    exitCode: 0,
                  };
                });
              }
              return real.exec(command, options);
            },
            copyIn: real.copyIn,
            copyFileOut: real.copyFileOut,
          };
        },
      },
    });

    try {
      await sandbox.run({
        agent: testProvider,
        prompt: "do something",
        maxIterations: 1,
        logging: { type: "file", path: logPath },
      });

      const log = await readFile(logPath, "utf-8");
      expect(log).not.toContain(droppedToolLine);
      expect(log).not.toContain(recognisedLine);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.exec() runs a command and returns the ExecResult (test-mode path)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-exec-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const result = await sandbox.exec("echo hello");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.exec() defaults cwd to the sandbox repo path", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-exec-cwd-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const result = await sandbox.exec("pwd");
      // In test mode, sandboxRepoDir === worktreePath.
      expect(result.stdout.trim()).toBe(sandbox.worktreePath);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.exec() returns non-zero exit codes without throwing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-exec-nonzero-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const result = await sandbox.exec("exit 7");
      expect(result.exitCode).toBe(7);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.exec() allows the caller to override the default cwd", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-exec-cwd-override",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const result = await sandbox.exec("pwd", { cwd: hostDir });
      expect(result.stdout.trim()).toBe(hostDir);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.exec() delegates to providerHandle.exec() (non-test mode)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const gitTmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
    const globalConfigPath = join(gitTmpDir, ".gitconfig");
    writeFileSync(globalConfigPath, "");
    const isolatedEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfigPath,
    };

    let userExecCmd: string | undefined;
    let userExecCwd: string | undefined;

    const spyProvider = createBindMountSandboxProvider({
      name: "spy-exec",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          // Sandcastle issues a `git config --global --add safe.directory ...`
          // command before user code can run; only record the user-issued one.
          if (cmd === "echo hello-from-provider") {
            userExecCmd = cmd;
            userExecCwd = execOpts?.cwd;
            return {
              stdout: "hello-from-provider\n",
              stderr: "",
              exitCode: 0,
            };
          }
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd, env: isolatedEnv });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-exec-delegates",
      sandbox: spyProvider,
      cwd: hostDir,
    });

    try {
      const result = await sandbox.exec("echo hello-from-provider");
      expect(result.stdout).toBe("hello-from-provider\n");
      expect(userExecCmd).toBe("echo hello-from-provider");
      // cwd should default to the provider's worktreePath.
      expect(userExecCwd).toBe(sandbox.worktreePath);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
      await rm(gitTmpDir, { recursive: true, force: true });
    }
  });

  it("sandbox.close() removes worktree when clean, returns no preservedWorktreePath", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-clean-close",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    const worktreePath = sandbox.worktreePath;
    const closeResult = await sandbox.close();

    expect(closeResult.preservedWorktreePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("sandbox.close() preserves worktree when dirty, returns preservedWorktreePath", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-dirty-close",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    // Make the worktree dirty
    await writeFile(join(sandbox.worktreePath, "dirty.txt"), "uncommitted");

    const closeResult = await sandbox.close();

    expect(closeResult.preservedWorktreePath).toBe(sandbox.worktreePath);
    expect(existsSync(sandbox.worktreePath)).toBe(true);

    // Clean up manually
    await rm(sandbox.worktreePath, { recursive: true, force: true });
    await execAsync(`git worktree prune`, { cwd: hostDir });
    await rm(hostDir, { recursive: true, force: true });
  });

  it("Symbol.asyncDispose works via await using", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let worktreePath: string;
    {
      await using sandbox = await createSandbox({
        branch: "test-dispose-branch",
        sandbox: testSandbox,
        cwd: hostDir,
        _test: {
          buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
        },
      });
      worktreePath = sandbox.worktreePath;
      expect(existsSync(worktreePath)).toBe(true);
    }
    // After block exit, worktree should be cleaned up
    expect(existsSync(worktreePath!)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("reuses clean worktree when branch is already checked out", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox1 = await createSandbox({
      branch: "collision-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const sandbox2 = await createSandbox({
        branch: "collision-branch",
        sandbox: testSandbox,
        cwd: hostDir,
        _test: {
          buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
        },
      });

      expect(sandbox2.worktreePath).toBe(sandbox1.worktreePath);
      expect(sandbox2.branch).toBe("collision-branch");
      await sandbox2.close();
    } finally {
      await sandbox1.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("reuses dirty worktree with warning (ADR 0003)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox1 = await createSandbox({
      branch: "dirty-collision",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    // Make the worktree dirty
    await writeFile(join(sandbox1.worktreePath, "dirty.txt"), "uncommitted");

    try {
      const sandbox2 = await createSandbox({
        branch: "dirty-collision",
        sandbox: testSandbox,
        cwd: hostDir,
        _test: {
          buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
        },
      });

      // Should reuse the same worktree path
      expect(sandbox2.worktreePath).toBe(sandbox1.worktreePath);
      expect(sandbox2.branch).toBe("dirty-collision");

      await sandbox2.close();
    } finally {
      await rm(sandbox1.worktreePath, { recursive: true, force: true });
      await execAsync("git worktree prune", { cwd: hostDir });
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() returns commits made during the run", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-commits-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async (cwd) => {
            await writeFile(join(cwd, "agent-created.txt"), "new file");
            await execAsync("git add agent-created.txt", { cwd });
            await execAsync('git commit -m "agent commit"', { cwd });
            return "done";
          }),
      },
    });

    try {
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "create a file",
        maxIterations: 1,
      });

      expect(result.commits.length).toBeGreaterThanOrEqual(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.close() is idempotent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-idempotent-close",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    const result1 = await sandbox.close();
    const result2 = await sandbox.close();

    expect(result1.preservedWorktreePath).toBeUndefined();
    expect(result2.preservedWorktreePath).toBeUndefined();
    await rm(hostDir, { recursive: true, force: true });
  });

  it("two sequential runs with different agents and prompts succeed on the same sandbox", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-multi-run",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "mock output"),
      },
    });

    try {
      const result1 = await sandbox.run({
        agent: testProvider,
        prompt: "implement feature",
        maxIterations: 1,
        name: "Implementer",
      });

      const result2 = await sandbox.run({
        agent: testPiProvider,
        prompt: "review the code",
        maxIterations: 1,
        name: "Reviewer",
      });

      expect(result1.iterations.length).toBe(1);
      expect(result2.iterations.length).toBe(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("commits from multiple runs accumulate on the branch", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let runCount = 0;
    const sandbox = await createSandbox({
      branch: "test-commit-accumulation",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async (cwd) => {
            runCount++;
            const fname = `file-${runCount}.txt`;
            await writeFile(join(cwd, fname), `content ${runCount}`);
            await execAsync(`git add ${fname}`, { cwd });
            await execAsync(`git commit -m "commit from run ${runCount}"`, {
              cwd,
            });
            return `done run ${runCount}`;
          }),
      },
    });

    try {
      const result1 = await sandbox.run({
        agent: testProvider,
        prompt: "first run",
        maxIterations: 1,
      });

      const result2 = await sandbox.run({
        agent: testProvider,
        prompt: "second run",
        maxIterations: 1,
      });

      expect(result1.commits.length).toBeGreaterThanOrEqual(1);
      expect(result2.commits.length).toBeGreaterThanOrEqual(1);

      // Verify both commits exist on the branch
      const { stdout: log } = await execAsync(
        `git log --oneline test-commit-accumulation`,
        { cwd: hostDir },
      );
      expect(log).toContain("commit from run 1");
      expect(log).toContain("commit from run 2");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("onSandboxReady hooks execute once at creation time", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-hooks",
      sandbox: testSandbox,
      hooks: {
        sandbox: {
          onSandboxReady: [
            { command: "touch /tmp/hook-marker.txt" },
            { command: "echo 'hook-ran' > hook-output.txt" },
          ],
        },
      },
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      // The hook wrote a file into the worktree (cwd is sandboxRepoDir = worktreePath in test mode)
      const hookOutput = await readFile(
        join(sandbox.worktreePath, "hook-output.txt"),
        "utf-8",
      );
      expect(hookOutput.trim()).toBe("hook-ran");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("provider's create() is called exactly once across multiple .run() calls", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let createCallCount = 0;
    let closeCallCount = 0;

    // Isolated git config so global writes don't pollute developer config
    const gitTmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
    const globalConfigPath = join(gitTmpDir, ".gitconfig");
    writeFileSync(globalConfigPath, "");
    const isolatedEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfigPath,
    };

    const spyProvider = createBindMountSandboxProvider({
      name: "spy",
      create: async (opts) => {
        createCallCount++;
        const workDir = opts.worktreePath;
        return {
          worktreePath: workDir,
          exec: async (cmd, execOpts) => {
            const cwd = execOpts?.cwd ?? workDir;
            if (cmd.startsWith("claude ") && execOpts?.onLine) {
              const onLine = execOpts.onLine;
              const output = toStreamJson("mock output");
              for (const line of output.split("\n")) onLine(line);
              return { stdout: output, stderr: "", exitCode: 0 };
            }
            if (cmd.startsWith("claude ")) {
              return { stdout: "mock", stderr: "", exitCode: 0 };
            }
            const result = await execAsync(cmd, { cwd, env: isolatedEnv });
            if (execOpts?.onLine) {
              for (const line of result.stdout.split("\n"))
                execOpts.onLine(line);
            }
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: 0,
            };
          },
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {
            closeCallCount++;
          },
        };
      },
    });

    const sandbox = await createSandbox({
      branch: "test-create-once",
      sandbox: spyProvider,
      cwd: hostDir,
    });

    try {
      expect(createCallCount).toBe(1);

      await sandbox.run({
        agent: testProvider,
        prompt: "first run",
        maxIterations: 1,
      });
      expect(createCallCount).toBe(1);

      await sandbox.run({
        agent: testProvider,
        prompt: "second run",
        maxIterations: 1,
      });
      expect(createCallCount).toBe(1);
    } finally {
      await sandbox.close();
      expect(closeCallCount).toBe(1);
      await rm(hostDir, { recursive: true, force: true });
      await rm(gitTmpDir, { recursive: true, force: true });
    }
  });

  it("close() delegates to the provider handle's close()", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let providerClosed = false;

    const gitTmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
    const globalConfigPath = join(gitTmpDir, ".gitconfig");
    writeFileSync(globalConfigPath, "");
    const isolatedEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfigPath,
    };

    const spyProvider = createBindMountSandboxProvider({
      name: "spy-close",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          if (cmd.startsWith("claude ") && execOpts?.onLine) {
            const onLine = execOpts.onLine;
            const output = toStreamJson("mock");
            for (const line of output.split("\n")) onLine(line);
            return { stdout: output, stderr: "", exitCode: 0 };
          }
          if (cmd.startsWith("claude "))
            return { stdout: "mock", stderr: "", exitCode: 0 };
          const result = await execAsync(cmd, { cwd, env: isolatedEnv });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {
          providerClosed = true;
        },
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-close-delegates",
      sandbox: spyProvider,
      cwd: hostDir,
    });

    expect(providerClosed).toBe(false);
    await sandbox.close();
    expect(providerClosed).toBe(true);

    await rm(hostDir, { recursive: true, force: true });
    await rm(gitTmpDir, { recursive: true, force: true });
  });

  it("state persists between runs — file created in run 1 exists in run 2", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let runNumber = 0;
    const sandbox = await createSandbox({
      branch: "test-state-persistence",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async (cwd) => {
            runNumber++;
            if (runNumber === 1) {
              // Run 1: create a file (non-committed state)
              await writeFile(join(cwd, "persistent-state.txt"), "from-run-1");
              return "created file";
            }
            // Run 2: verify the file still exists
            const content = await readFile(
              join(cwd, "persistent-state.txt"),
              "utf-8",
            );
            if (content !== "from-run-1") {
              throw new Error("State did not persist between runs!");
            }
            return "verified file exists";
          }),
      },
    });

    try {
      await sandbox.run({
        agent: testProvider,
        prompt: "create file",
        maxIterations: 1,
      });

      // Verify file exists on host between runs
      const content = await readFile(
        join(sandbox.worktreePath, "persistent-state.txt"),
        "utf-8",
      );
      expect(content).toBe("from-run-1");

      // Run 2 — the mock agent verifies the file persists inside the sandbox
      await sandbox.run({
        agent: testProvider,
        prompt: "verify file",
        maxIterations: 1,
      });
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("works with isolated sandbox providers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = testIsolated();
    const sandbox = await createSandbox({
      branch: "test-isolated-branch",
      sandbox: provider,
      cwd: hostDir,
    });

    try {
      expect(sandbox.branch).toBe("test-isolated-branch");
      expect(sandbox.worktreePath).toContain(".sandcastle/worktrees");
      expect(existsSync(sandbox.worktreePath)).toBe(true);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("isolated provider: run() syncs commits to host worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = makeMockIsolatedProvider();
    const sandbox = await createSandbox({
      branch: "test-isolated-commits",
      sandbox: provider,
      cwd: hostDir,
    });

    try {
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "create a file",
        maxIterations: 1,
      });

      expect(result.iterations.length).toBe(1);

      // Verify the worktree exists and is on the right branch
      const { stdout: branch } = await execAsync(
        "git rev-parse --abbrev-ref HEAD",
        { cwd: sandbox.worktreePath },
      );
      expect(branch.trim()).toBe("test-isolated-commits");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("isolated provider: close() cleans up properly", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = testIsolated();
    const sandbox = await createSandbox({
      branch: "test-isolated-close",
      sandbox: provider,
      cwd: hostDir,
    });

    const worktreePath = sandbox.worktreePath;
    const closeResult = await sandbox.close();

    expect(closeResult.preservedWorktreePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("isolated provider: sequential runs with commits sync correctly", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let runCount = 0;
    const provider = makeMockIsolatedProvider(async (cwd) => {
      runCount++;
      const fname = `isolated-file-${runCount}.txt`;
      await writeFile(join(cwd, fname), `content ${runCount}`);
      await execAsync(`git add ${fname}`, { cwd });
      await execAsync(`git commit -m "isolated commit ${runCount}"`, { cwd });
      return `done run ${runCount}`;
    });

    const sandbox = await createSandbox({
      branch: "test-isolated-multi-run",
      sandbox: provider,
      cwd: hostDir,
    });

    try {
      const result1 = await sandbox.run({
        agent: testProvider,
        prompt: "first run",
        maxIterations: 1,
      });
      expect(result1.commits.length).toBeGreaterThanOrEqual(1);

      const result2 = await sandbox.run({
        agent: testProvider,
        prompt: "second run",
        maxIterations: 1,
      });
      expect(result2.commits.length).toBeGreaterThanOrEqual(1);

      // Verify both commits exist on the host worktree branch
      const { stdout: log } = await execAsync(
        `git log --oneline test-isolated-multi-run`,
        { cwd: hostDir },
      );
      expect(log).toContain("isolated commit 1");
      expect(log).toContain("isolated commit 2");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() invokes interactiveExec and returns result", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const receivedArgs: string[] = [];

    // Create a provider that has interactiveExec
    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          if (execOpts?.onLine) {
            for (const line of result.stdout.split("\n")) execOpts.onLine(line);
          }
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        interactiveExec: async (args, _opts) => {
          receivedArgs.push(...args);
          return { exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-interactive",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    try {
      const result = await sandbox.interactive({
        agent: testProvider,
        prompt: "do something interactively",
      });

      expect(result.exitCode).toBe(0);
      expect(Array.isArray(result.commits)).toBe(true);
      expect(receivedArgs).toContain("do something interactively");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() reuses the same sandbox handle", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let createCallCount = 0;

    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive-reuse",
      create: async (opts) => {
        createCallCount++;
        return {
          worktreePath: opts.worktreePath,
          exec: async (cmd, execOpts) => {
            const cwd = execOpts?.cwd ?? opts.worktreePath;
            const result = await execAsync(cmd, { cwd });
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: 0,
            };
          },
          interactiveExec: async () => ({ exitCode: 0 }),
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {},
        };
      },
    });

    const sandbox = await createSandbox({
      branch: "test-interactive-reuse",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    try {
      expect(createCallCount).toBe(1);
      await sandbox.interactive({
        agent: testProvider,
        prompt: "first interactive",
      });
      expect(createCallCount).toBe(1);
      await sandbox.interactive({
        agent: testProvider,
        prompt: "second interactive",
      });
      expect(createCallCount).toBe(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() collects commits made during session", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive-commits",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        interactiveExec: async (_args, opts) => {
          // Simulate agent making a commit
          const cwd = opts.cwd!;
          await writeFile(
            join(cwd, "interactive-file.txt"),
            "interactive content",
          );
          await execAsync("git add interactive-file.txt", { cwd });
          await execAsync('git commit -m "interactive commit"', { cwd });
          return { exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-interactive-commits",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    try {
      const result = await sandbox.interactive({
        agent: testProvider,
        prompt: "add a file",
      });

      expect(result.commits.length).toBeGreaterThanOrEqual(1);
      expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() throws when provider lacks interactiveExec", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    // Provider without interactiveExec
    const noInteractiveProvider = createBindMountSandboxProvider({
      name: "test-no-interactive",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-no-interactive",
      sandbox: noInteractiveProvider,
      cwd: hostDir,
    });

    try {
      await expect(
        sandbox.interactive({
          agent: testProvider,
          prompt: "test",
        }),
      ).rejects.toThrow("interactiveExec");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() substitutes {{KEY}} placeholders in prompts", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const receivedArgs: string[] = [];

    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive-args",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        interactiveExec: async (args, _opts) => {
          receivedArgs.push(...args);
          return { exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-interactive-args",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    const promptFile = join(hostDir, "interactive-args-prompt.md");
    await writeFile(promptFile, "Fix bug in {{COMPONENT}}");

    try {
      await sandbox.interactive({
        agent: testProvider,
        promptFile,
        promptArgs: { COMPONENT: "LoginForm" },
      });

      const promptArg = receivedArgs[receivedArgs.length - 1]!;
      expect(promptArg).toContain("LoginForm");
      expect(promptArg).not.toContain("{{COMPONENT}}");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() accepts signal option (type check)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-signal-type",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    try {
      const ac = new AbortController();
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "do something",
        signal: ac.signal,
      });
      expect(result.iterations.length).toBe(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() rejects immediately with pre-aborted signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-signal-pre-abort",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    try {
      const reason = new DOMException("cancelled", "AbortError");
      const ac = new AbortController();
      ac.abort(reason);

      await expect(
        sandbox.run({
          agent: testProvider,
          prompt: "do something",
          signal: ac.signal,
        }),
      ).rejects.toThrow("cancelled");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() abort leaves handle usable for next run", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-signal-reuse",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    try {
      // First run: abort
      const ac = new AbortController();
      ac.abort(new DOMException("cancelled", "AbortError"));
      await expect(
        sandbox.run({
          agent: testProvider,
          prompt: "will be aborted",
          signal: ac.signal,
        }),
      ).rejects.toThrow("cancelled");

      // Second run: succeeds with fresh signal
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "should succeed",
        signal: new AbortController().signal,
      });
      expect(result.iterations.length).toBe(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() abort then close() works cleanly", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-signal-then-close",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    // Abort
    const ac = new AbortController();
    ac.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      sandbox.run({
        agent: testProvider,
        prompt: "will be aborted",
        signal: ac.signal,
      }),
    ).rejects.toThrow("cancelled");

    // Close should work fine
    const closeResult = await sandbox.close();
    expect(closeResult.preservedWorktreePath).toBeUndefined();
    await rm(hostDir, { recursive: true, force: true });
  });

  it("sandbox.interactive() accepts signal option (type check)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive-signal",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        interactiveExec: async () => ({ exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-interactive-signal",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    try {
      const result = await sandbox.interactive({
        agent: testProvider,
        prompt: "test",
        signal: new AbortController().signal,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() rejects with pre-aborted signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive-preabort",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        interactiveExec: async () => ({ exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-interactive-preabort",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    try {
      const ac = new AbortController();
      ac.abort(new DOMException("interactive-cancelled", "AbortError"));

      await expect(
        sandbox.interactive({
          agent: testProvider,
          prompt: "test",
          signal: ac.signal,
        }),
      ).rejects.toThrow("interactive-cancelled");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("createSandbox() does not accept signal option (type check)", () => {
    // This test validates at the type level — createSandbox should NOT accept signal.
    // If someone adds signal to CreateSandboxOptions, this will fail at compile time.
    const opts: CreateSandboxOptions = {
      branch: "test",
      sandbox: testSandbox,
    };
    // Verify signal is not a key on the options type
    type HasSignal = "signal" extends keyof CreateSandboxOptions ? true : false;
    const check: HasSignal = false;
    expect(check).toBe(false);
    expect(opts).toBeDefined();
  });

  it("forks new branch from baseBranch when specified", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    // Record the base commit's SHA before adding a second commit on main
    const { stdout: baseSha } = await execAsync("git rev-parse HEAD", {
      cwd: hostDir,
    });
    await commitFile(hostDir, "second.txt", "second", "second commit");

    const sandbox = await createSandbox({
      branch: "feature/from-base",
      baseBranch: baseSha.trim(),
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const { stdout: worktreeHead } = await execAsync("git rev-parse HEAD", {
        cwd: sandbox.worktreePath,
      });
      expect(worktreeHead.trim()).toBe(baseSha.trim());
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("removes the worktree when sandbox start fails (no orphan)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const failingProvider = createBindMountSandboxProvider({
      name: "failing-create",
      create: async () => {
        throw new Error("Image 'sandcastle:test' not found locally");
      },
    });

    try {
      await expect(
        createSandbox({
          branch: "test-start-fails",
          sandbox: failingProvider,
          cwd: hostDir,
        }),
      ).rejects.toThrow();

      // The worktree must not be left orphaned on disk.
      const worktreesDir = join(hostDir, ".sandcastle", "worktrees");
      const leftover = existsSync(worktreesDir)
        ? readdirSync(worktreesDir)
        : [];
      expect(leftover).toHaveLength(0);

      const { stdout } = await execAsync("git worktree list", { cwd: hostDir });
      expect(stdout).not.toContain(".sandcastle/worktrees");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("copyToWorktree copies files into the worktree at creation time", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    // Create untracked files in the host repo that should be copied
    await writeFile(join(hostDir, "config.json"), '{"key": "value"}');

    const sandbox = await createSandbox({
      branch: "test-copy",
      sandbox: testSandbox,
      copyToWorktree: ["config.json"],
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const copied = await readFile(
        join(sandbox.worktreePath, "config.json"),
        "utf-8",
      );
      expect(JSON.parse(copied)).toEqual({ key: "value" });
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });
});
