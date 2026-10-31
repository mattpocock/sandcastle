import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  assert,
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  buildAgentStreamHandler,
  buildCompletionMessage,
  buildLogFilename,
  buildRunSummaryRows,
  buildStructuredOutputRetryFeedback,
  DEFAULT_MAX_ITERATIONS,
  printFileDisplayStartup,
  run,
  sanitizeBranchForFilename,
} from "./run.js";
import type { RunOptions, RunResult } from "./run.js";
import { claudeCode, copilot, cursor } from "./AgentProvider.js";
import type { AgentProvider } from "./AgentProvider.js";
import { ForkNotSupportedError } from "./errors.js";
import { Output, StructuredOutputError } from "./Output.js";
import { claudeHostSessionPath } from "./SessionStore.js";
import type { InteractiveOptions } from "./interactive.js";
import type { WorktreeInteractiveOptions } from "./createWorktree.js";
import { defaultImageName } from "./sandboxes/docker.js";
import * as sandcastle from "./SandboxProvider.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import { testStubProvider } from "./sandboxes/test-shared.js";

const testSandbox = testStubProvider({ name: "test" }).provider;

/** An agent provider with no session storage, so it cannot resume. */
const noResumeAgent: AgentProvider = {
  name: "no-resume-agent",
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({ command: "true" }),
  parseStreamLine: () => [],
};

describe("printFileDisplayStartup", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.FORCE_COLOR = "1";
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.FORCE_COLOR;
  });

  it("does not use clack (no @clack/prompts calls)", async () => {
    const clack = await import("@clack/prompts");
    const clackSpy = vi
      .spyOn(clack.log, "success")
      .mockImplementation(() => {});
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    expect(clackSpy).not.toHaveBeenCalled();
    clackSpy.mockRestore();
  });

  it("uses console.log for output", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("shows '[Agent] Started' when no name is provided", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("[Agent]");
    expect(allOutput).toContain("Started");
  });

  it("shows custom agent name when provided", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
      agentName: "my-run",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("[my-run]");
  });

  it("shows branch name when provided", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
      branch: "sandcastle/issue-124-file-logging",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("sandcastle/issue-124-file-logging");
  });

  it("shows tail command with relative log path", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("tail -f");
  });

  it("uses bold styling for the agent name bracket", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    // Bold ANSI escape code
    expect(allOutput).toContain("\u001B[1m");
  });

  it("prints a relative log path when hostRepoDir equals process.cwd()", () => {
    const logPath = join(process.cwd(), ".sandcastle", "logs", "main.log");
    printFileDisplayStartup({
      logPath,
      hostRepoDir: process.cwd(),
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("tail -f .sandcastle/logs/main.log");
    expect(allOutput).not.toContain(process.cwd());
  });

  it("prints an absolute log path when hostRepoDir differs from process.cwd()", () => {
    const hostRepoDir = "/some/other/repo";
    const logPath = join(hostRepoDir, ".sandcastle", "logs", "main.log");
    printFileDisplayStartup({
      logPath,
      hostRepoDir,
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain(
      "tail -f /some/other/repo/.sandcastle/logs/main.log",
    );
  });
});

describe("buildAgentStreamHandler (verbose file mode)", () => {
  const rawEvent = (line: string) =>
    ({ type: "raw", line, iteration: 1, timestamp: new Date() }) as const;

  it("starts a raw line on a fresh line when the log ends mid-line", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbose-sink-"));
    try {
      const logPath = join(dir, "run.log");
      // FileDisplay streams agent prose as raw chunks with no trailing newline.
      writeFileSync(logPath, "I'll commit the result myself.");
      const handler = buildAgentStreamHandler({
        type: "file",
        path: logPath,
        verbose: true,
      });
      assert.isDefined(handler);
      handler(rawEvent('{"type":"assistant"}'));
      expect(readFileSync(logPath, "utf8")).toBe(
        'I\'ll commit the result myself.\n{"type":"assistant"}\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds no blank line when the log already ends with a newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbose-sink-"));
    try {
      const logPath = join(dir, "run.log");
      writeFileSync(logPath, "Agent started\n");
      const handler = buildAgentStreamHandler({
        type: "file",
        path: logPath,
        verbose: true,
      });
      assert.isDefined(handler);
      handler(rawEvent('{"type":"system"}'));
      handler(rawEvent('{"type":"assistant"}'));
      expect(readFileSync(logPath, "utf8")).toBe(
        'Agent started\n{"type":"system"}\n{"type":"assistant"}\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildCompletionMessage", () => {
  it("returns success message when completion signal was detected", () => {
    const result = buildCompletionMessage("<promise>COMPLETE</promise>", 3);
    expect(result.message).toBe(
      "Run complete: agent finished after 3 iteration(s).",
    );
    expect(result.severity).toBe("success");
  });

  it("returns warn message when max iterations reached without signal", () => {
    const result = buildCompletionMessage(undefined, 5);
    expect(result.message).toBe(
      "Run complete: reached 5 iteration(s) without completion signal.",
    );
    expect(result.severity).toBe("warn");
  });

  it("reflects the correct iteration count for 1 iteration", () => {
    const result = buildCompletionMessage("<promise>COMPLETE</promise>", 1);
    expect(result.message).toContain("1 iteration(s)");
  });
});

describe("RunResult", () => {
  it("includes logFilePath when logging to a file", () => {
    const result: RunResult = {
      iterations: [{ sessionId: undefined }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
      logFilePath: "/path/to/sandcastle.log",
    };
    expect(result.logFilePath).toBe("/path/to/sandcastle.log");
  });

  it("allows logFilePath to be absent when logging to stdout", () => {
    const result: RunResult = {
      iterations: [{ sessionId: undefined }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.logFilePath).toBeUndefined();
  });

  it("carries sessionId in iterations for Claude Code runs", () => {
    const result: RunResult = {
      iterations: [{ sessionId: "abc-123" }, { sessionId: "def-456" }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.iterations).toHaveLength(2);
    expect(result.iterations[0]?.sessionId).toBe("abc-123");
    expect(result.iterations[1]?.sessionId).toBe("def-456");
  });

  it("has undefined sessionId for non-Claude agent iterations", () => {
    const result: RunResult = {
      iterations: [{ sessionId: undefined }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    const [iteration] = result.iterations;
    assert.isDefined(iteration);
    expect(iteration.sessionId).toBeUndefined();
  });

  it("carries sessionFilePath when session capture is enabled", () => {
    const result: RunResult = {
      iterations: [
        {
          sessionId: "abc-123",
          sessionFilePath:
            "/home/user/.claude/projects/-home-user-repo/abc-123.jsonl",
        },
      ],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.iterations[0]?.sessionFilePath).toContain("abc-123.jsonl");
  });

  it("has undefined sessionFilePath when capture is disabled", () => {
    const result: RunResult = {
      iterations: [{ sessionId: "abc-123", sessionFilePath: undefined }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    const [iteration] = result.iterations;
    assert.isDefined(iteration);
    expect(iteration.sessionFilePath).toBeUndefined();
  });

  it("allows fork as an optional sibling of resume on the type", () => {
    // Compile-time shape check: fork takes (prompt, options?) and returns
    // Promise<RunResult>, matching resume. Mirrors ADR 0018.
    const result: RunResult = {
      iterations: [{ sessionId: "abc-123" }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
      fork: async () => ({
        iterations: [],
        stdout: "",
        commits: [],
        branch: "main",
      }),
    };
    expect(result.fork).toBeTypeOf("function");
  });
});

describe("DEFAULT_MAX_ITERATIONS", () => {
  it("is 1", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(1);
  });
});

describe("RunOptions", () => {
  it("requires agent field typed as AgentProvider", () => {
    // @ts-expect-error agent is required
    const _opts: RunOptions = { prompt: "test" };
  });

  it("requires sandbox field typed as SandboxProvider", () => {
    // @ts-expect-error sandbox is required
    const _opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      prompt: "test",
    };
  });

  it("allows idleTimeoutSeconds to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
      idleTimeoutSeconds: 120,
    };
    expect(opts.idleTimeoutSeconds).toBe(120);
  });

  it("allows idleTimeoutSeconds to be omitted (uses default)", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.idleTimeoutSeconds).toBeUndefined();
  });

  it("allows name to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
      name: "my-run",
    };
    expect(opts.name).toBe("my-run");
  });

  it("allows name to be omitted", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.name).toBeUndefined();
  });

  it("does not accept a worktree field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error worktree is no longer a valid field on RunOptions
    expect(opts.worktree).toBeUndefined();
  });

  it("allows cwd to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
      cwd: "/some/repo",
    };
    expect(opts.cwd).toBe("/some/repo");
  });

  it("allows cwd to be omitted (defaults to process.cwd())", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.cwd).toBeUndefined();
  });

  it("does not accept a top-level branch field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error branch is no longer a valid field on RunOptions
    expect(opts.branch).toBeUndefined();
  });

  it("does not accept a top-level imageName field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error imageName is no longer a valid field on RunOptions
    expect(opts.imageName).toBeUndefined();
  });
});

describe("signal (AbortSignal)", () => {
  it("allows signal to be specified on RunOptions", () => {
    const ac = new AbortController();
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
      signal: ac.signal,
    };
    expect(opts.signal).toBe(ac.signal);
  });

  it("allows signal to be omitted", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.signal).toBeUndefined();
  });

  it("rejects immediately with pre-aborted signal without doing setup", async () => {
    const ac = new AbortController();
    ac.abort("cancelled before start");
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        signal: ac.signal,
      }),
    ).rejects.toThrow("cancelled before start");
  });

  it("surfaces signal.reason verbatim (no wrapping)", async () => {
    const reason = new DOMException("user cancelled", "AbortError");
    const ac = new AbortController();
    ac.abort(reason);
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        signal: ac.signal,
      }),
    ).rejects.toBe(reason);
  });
});

describe("resumeSession validation", () => {
  it("throws when resumeSession is set with maxIterations > 1", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        resumeSession: "abc-123",
        maxIterations: 2,
      }),
    ).rejects.toThrow(
      "resumeSession cannot be combined with maxIterations > 1",
    );
  });

  it("throws when resumeSession file does not exist on host", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        resumeSession: "nonexistent-session-id",
      }),
    ).rejects.toThrow('resumeSession "nonexistent-session-id" not found');
  });

  it("allows resumeSession with maxIterations = 1 (default)", async () => {
    // This should fail for a different reason (missing session file),
    // not the maxIterations validation
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        resumeSession: "abc-123",
      }),
    ).rejects.toThrow('resumeSession "abc-123" not found');
  });
});

describe("forkSession validation", () => {
  it("throws when forkSession is set without resumeSession", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        // forkSession is @internal; the user-facing surface is RunResult.fork().
        // This guard exists so a caller setting the internal flag directly gets
        // a clear error instead of a silently-ignored fork flag.
        forkSession: true,
      } as RunOptions),
    ).rejects.toThrow("forkSession requires resumeSession");
  });
});

describe("timeout option validation", () => {
  it("rejects idleTimeoutSeconds: 0 before starting anything", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        idleTimeoutSeconds: 0,
      }),
    ).rejects.toThrow(
      "idleTimeoutSeconds must be a positive number of seconds. Received: 0",
    );
  });

  it("rejects a negative completionTimeoutSeconds", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        completionTimeoutSeconds: -1,
      }),
    ).rejects.toThrow("completionTimeoutSeconds must be a positive number");
  });

  it("rejects timeouts.gitSetupMs: NaN", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        timeouts: { gitSetupMs: Number.NaN },
      }),
    ).rejects.toThrow("timeouts.gitSetupMs must be a positive number");
  });
});

describe("copyToWorktree with head branch strategy", () => {
  it("throws a runtime error when copyToWorktree is provided with head strategy", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        copyToWorktree: [".env"],
      }),
    ).rejects.toThrow(
      "copyToWorktree is not supported with head branch strategy",
    );
  });
});

describe("branchStrategy on RunOptions", () => {
  it("throws when head strategy is used with an isolated provider", async () => {
    const isolatedSandbox = sandcastle.createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => ({
        worktreePath: "/workspace",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: isolatedSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
      }),
    ).rejects.toThrow(
      "head branch strategy is not supported with isolated providers",
    );
  });
});

describe("buildRunSummaryRows", () => {
  it("uses the custom name as Agent when name is provided", () => {
    const rows = buildRunSummaryRows({
      name: "Implementer #202",
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 3,
      branch: "main",
    });
    expect(rows["Agent"]).toBe("Implementer #202");
  });

  it("falls back to agentName when no name is provided", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 1,
      branch: "main",
    });
    expect(rows["Agent"]).toBe("claude-code");
  });

  it("includes sandbox name, max iterations, and branch", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 5,
      branch: "sandcastle/issue-160",
    });
    expect(rows["Sandbox"]).toBe("docker");
    expect(rows["Max iterations"]).toBe("5");
    expect(rows["Branch"]).toBe("sandcastle/issue-160");
  });

  it("does not include a Model row", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 1,
      branch: "main",
    });
    expect(rows["Model"]).toBeUndefined();
  });
});

describe("sanitizeBranchForFilename", () => {
  it("passes through a simple branch name unchanged", () => {
    expect(sanitizeBranchForFilename("main")).toBe("main");
  });

  it("replaces forward slashes with dashes", () => {
    expect(sanitizeBranchForFilename("sandcastle/issue-87-log-file")).toBe(
      "sandcastle-issue-87-log-file",
    );
  });

  it("replaces backslashes with dashes", () => {
    expect(sanitizeBranchForFilename(String.raw`feature\branch`)).toBe(
      "feature-branch",
    );
  });

  it("replaces all problematic filesystem characters", () => {
    expect(sanitizeBranchForFilename('feat:name*?"><|')).toBe(
      "feat-name------",
    );
  });

  it("handles nested slashes like a typical sandcastle branch", () => {
    expect(
      sanitizeBranchForFilename("sandcastle/issue-87-log-file-branch-name"),
    ).toBe("sandcastle-issue-87-log-file-branch-name");
  });
});

describe("defaultImageName", () => {
  it("returns sandcastle:<dir-name> for a typical repo path", () => {
    expect(defaultImageName("/home/user/my-project")).toBe(
      "sandcastle:my-project",
    );
  });

  it("lowercases the directory name", () => {
    expect(defaultImageName("/home/user/MyProject")).toBe(
      "sandcastle:myproject",
    );
  });

  it("replaces characters invalid in Docker image tags with dashes", () => {
    expect(defaultImageName("/home/user/my project")).toBe(
      "sandcastle:my-project",
    );
  });

  it("handles paths with trailing slash gracefully", () => {
    expect(defaultImageName("/home/user/my-repo/")).toBe("sandcastle:my-repo");
  });
});

describe("buildLogFilename", () => {
  it("returns sanitized branch + .log when no target branch", () => {
    expect(buildLogFilename("main")).toBe("main.log");
  });

  it("prefixes with target branch when temp branch is used", () => {
    expect(buildLogFilename("sandcastle/20260325-142719", "main")).toBe(
      "main-sandcastle-20260325-142719.log",
    );
  });

  it("sanitizes target branch with slashes", () => {
    expect(
      buildLogFilename("sandcastle/20260325-142719", "feature/my-work"),
    ).toBe("feature-my-work-sandcastle-20260325-142719.log");
  });

  it("includes agent name when branch contains agent segment", () => {
    expect(
      buildLogFilename("sandcastle/claude-code/20260325-142719", "main"),
    ).toBe("main-sandcastle-claude-code-20260325-142719.log");
  });

  it("appends run name when name is provided", () => {
    expect(buildLogFilename("main", undefined, "implementer")).toBe(
      "main-implementer.log",
    );
  });

  it("appends run name after target branch prefix", () => {
    expect(
      buildLogFilename("sandcastle/20260325-142719", "main", "reviewer"),
    ).toBe("main-sandcastle-20260325-142719-reviewer.log");
  });

  it("sanitizes run name for filename use", () => {
    expect(buildLogFilename("main", undefined, "my review agent")).toBe(
      "main-my-review-agent.log",
    );
  });
});

describe("promptFile resolution with cwd", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("resolves relative promptFile from process.cwd(), not from cwd", async () => {
    // ADR 0002 regression: promptFile must resolve against process.cwd()
    // regardless of what cwd is set to. This locks in the decision so it
    // is not accidentally reversed.
    const cwdDir = mkdtempSync(join(tmpdir(), "sandcastle-cwd-"));

    // Use a relative promptFile path that does not exist under either
    // process.cwd() or the custom cwd. The error message must reference
    // a resolution against process.cwd(), not cwdDir.
    const relativePromptFile = "nonexistent-prompt-file.md";

    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        promptFile: relativePromptFile,
        branchStrategy: { type: "head" },
        cwd: cwdDir,
      }),
    ).rejects.toThrow(relativePromptFile);
  });
});

describe("inline prompt passthrough", () => {
  it("errors when promptArgs is passed alongside an inline prompt", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "do the work",
        branchStrategy: { type: "head" },
        promptArgs: { ISSUE_NUMBER: "42" },
      }),
    ).rejects.toThrow("promptArgs is only supported with promptFile");
  });

  it("does not error on inline prompts that contain literal {{KEY}} text (issue #453)", async () => {
    // Before the fix, this would fail with "Prompt argument \"{{BRANCH}}\" has no
    // matching value". With inline passthrough, {{KEY}} is delivered literally
    // and substitution is skipped entirely, so no scan happens.
    //
    // The fake sandbox runs to completion, so the run resolves; a
    // prompt-substitution error would reject it.
    const promise = run({
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "Issue body mentions {{BRANCH}} in its content.",
      branchStrategy: { type: "head" },
    });

    await expect(promise).resolves.toHaveProperty("iterations");
  });

  it("accepts inline prompt with empty promptArgs ({})", async () => {
    // Spreading `...opts` where `opts.promptArgs` defaults to {} is a common
    // pattern. An empty args object is semantically the same as "not provided"
    // and must not trigger the inline-prompt guard.
    const promise = run({
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "do the work",
      branchStrategy: { type: "head" },
      promptArgs: {},
    });

    await expect(promise).resolves.toHaveProperty("iterations");
  });
});

describe("run() error logging to file", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("writes SandboxError to log file when using file logging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-run-error-"));
    const logPath = join(dir, "test.log");
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "test prompt");

    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        promptFile,
        branchStrategy: { type: "head" },
        promptArgs: { SOURCE_BRANCH: "override" },
        logging: { type: "file", path: logPath },
      }),
    ).rejects.toThrow();

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("SOURCE_BRANCH");
    expect(log).toContain("built-in prompt argument");
  });

  it("still propagates the error as a rejected promise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-run-error-"));
    const logPath = join(dir, "test.log");
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "test prompt");

    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        promptFile,
        branchStrategy: { type: "head" },
        promptArgs: { SOURCE_BRANCH: "override" },
        logging: { type: "file", path: logPath },
      }),
    ).rejects.toThrow("SOURCE_BRANCH");
  });
});

// ---------------------------------------------------------------------------
// Structured output validation
// ---------------------------------------------------------------------------

const mockSchema = () => ({
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
});

describe("structured output entry-time validation", () => {
  it("throws when output is set with maxIterations !== 1", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "emit <result>...</result>",
        branchStrategy: { type: "head" },
        output: Output.object({ tag: "result", schema: mockSchema() }),
        maxIterations: 2,
      }),
    ).rejects.toThrow("output requires maxIterations to be 1");
  });

  it("allows output with maxIterations = 1 (default)", async () => {
    // Should pass maxIterations check and fail later for a different reason
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "emit <result>...</result>",
        branchStrategy: { type: "head" },
        output: Output.object({ tag: "result", schema: mockSchema() }),
      }),
    ).rejects.not.toThrow("output requires maxIterations to be 1");
  });

  it("throws when output tag is not in the resolved prompt", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "do some work",
        branchStrategy: { type: "head" },
        output: Output.object({ tag: "result", schema: mockSchema() }),
      }),
    ).rejects.toThrow("output tag <result> not found in the resolved prompt");
  });

  it("passes tag check when the tag appears in the prompt", async () => {
    // Should pass the entry-time tag check and fail later for a different reason
    // (the mock sandbox produces empty stdout, so extraction fails — but not the prompt check)
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "emit your answer inside <result> tags",
        branchStrategy: { type: "head" },
        output: Output.object({ tag: "result", schema: mockSchema() }),
      }),
    ).rejects.not.toThrow("not found in the resolved prompt");
  });

  it("validates tag presence for Output.string as well", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "do some work",
        branchStrategy: { type: "head" },
        output: Output.string({ tag: "summary" }),
      }),
    ).rejects.toThrow("output tag <summary> not found in the resolved prompt");
  });

  it("validates tag presence with promptFile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-output-"));
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "do some work without the tag");

    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        promptFile,
        branchStrategy: { type: "head" },
        output: Output.object({ tag: "answer", schema: mockSchema() }),
      }),
    ).rejects.toThrow("output tag <answer> not found in the resolved prompt");
  });
});

describe("structured output error carries the failed session id", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // A sandbox whose agent invocation (the exec that receives `onLine`) streams
  // a Claude Code init line carrying a session id, followed by a result line
  // whose <result> tag holds malformed JSON. Extraction then fails and the
  // session id must survive onto the thrown error.
  const sessionEmittingSandbox = createBindMountSandboxProvider({
    name: "session-emitting",
    create: async () => ({
      worktreePath: "/home/agent/workspace",
      exec: async (
        _command: string,
        options?: { onLine?: (line: string) => void },
      ) => {
        if (options?.onLine) {
          options.onLine(
            '{"type":"system","subtype":"init","session_id":"sess-abc-123"}',
          );
          options.onLine(
            '{"type":"result","result":"<result>not valid json</result>"}',
          );
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      copyFileIn: async () => {},
      copyFileOut: async () => {},
      close: async () => {},
    }),
  });

  it("threads iterations[].sessionId onto StructuredOutputError", async () => {
    // captureSessions: false keeps the session id from the stream without
    // attempting to transfer a (nonexistent) session file off the sandbox.
    const promise = run({
      agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
      sandbox: sessionEmittingSandbox,
      prompt: "emit your answer inside <result> tags",
      branchStrategy: { type: "head" },
      output: Output.object({ tag: "result", schema: mockSchema() }),
    });
    await expect(promise).rejects.toBeInstanceOf(StructuredOutputError);
    await expect(promise).rejects.toMatchObject({
      sessionId: "sess-abc-123",
      rawMatched: "not valid json",
    });
  });
});

describe("RunOptions with output", () => {
  it("allows output field on RunOptions", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "emit <result>...</result>",
      output: Output.object({ tag: "result", schema: mockSchema() }),
    };
    expect(opts.output).toBeDefined();
  });

  it("allows output to be omitted", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-8"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.output).toBeUndefined();
  });
});

describe("output type-level exclusion", () => {
  it("InteractiveOptions does not accept output", () => {
    const opts: InteractiveOptions = {
      agent: claudeCode("claude-opus-4-8"),
      prompt: "test",
    };
    // @ts-expect-error output is not a field on InteractiveOptions
    expect(opts.output).toBeUndefined();
  });

  it("WorktreeInteractiveOptions does not accept output", () => {
    const opts: WorktreeInteractiveOptions = {
      agent: claudeCode("claude-opus-4-8"),
      prompt: "test",
    };
    // @ts-expect-error output is not a field on WorktreeInteractiveOptions
    expect(opts.output).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Structured output retry — entry-time validation (issue #825)
// ---------------------------------------------------------------------------

describe("output.maxRetries entry-time validation", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("throws when maxRetries > 0 and the agent provider lacks session resumption", async () => {
    await expect(
      run({
        agent: noResumeAgent,
        sandbox: testSandbox,
        prompt: "emit your answer inside <result> tags",
        branchStrategy: { type: "head" },
        output: Output.object({
          tag: "result",
          schema: mockSchema(),
          maxRetries: 2,
        }),
      }),
    ).rejects.toThrow(
      /output\.maxRetries requires an agent provider that supports session resumption/,
    );
  });

  it("throws when maxRetries > 0 and the agent provider lacks session resumption (no sessionStorage)", async () => {
    await expect(
      run({
        agent: noResumeAgent,
        sandbox: testSandbox,
        prompt: "emit your answer inside <result> tags",
        branchStrategy: { type: "head" },
        output: Output.string({ tag: "result", maxRetries: 1 }),
      }),
    ).rejects.toThrow(
      /output\.maxRetries requires an agent provider that supports session resumption/,
    );
  });

  it("names the non-resumable provider in the error message", async () => {
    await expect(
      run({
        agent: noResumeAgent,
        sandbox: testSandbox,
        prompt: "emit your answer inside <result> tags",
        branchStrategy: { type: "head" },
        output: Output.object({
          tag: "result",
          schema: mockSchema(),
          maxRetries: 1,
        }),
      }),
    ).rejects.toThrow(/"no-resume-agent"/u);
  });

  it("allows maxRetries = 0 with a non-resumable provider", async () => {
    // Should fail later for a different reason (the testSandbox produces no
    // <result> tag), not the maxRetries validation.
    await expect(
      run({
        agent: noResumeAgent,
        sandbox: testSandbox,
        prompt: "emit your answer inside <result> tags",
        branchStrategy: { type: "head" },
        output: Output.object({
          tag: "result",
          schema: mockSchema(),
          maxRetries: 0,
        }),
      }),
    ).rejects.not.toThrow(/output\.maxRetries requires/);
  });

  it("throws when maxRetries is negative", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "emit your answer inside <result> tags",
        branchStrategy: { type: "head" },
        output: Output.object({
          tag: "result",
          schema: mockSchema(),
          maxRetries: -1,
        }),
      }),
    ).rejects.toThrow(/non-negative integer/);
  });

  it("throws when maxRetries is not an integer", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: testSandbox,
        prompt: "emit your answer inside <result> tags",
        branchStrategy: { type: "head" },
        output: Output.object({
          tag: "result",
          schema: mockSchema(),
          maxRetries: 1.5,
        }),
      }),
    ).rejects.toThrow(/non-negative integer/);
  });
});

// ---------------------------------------------------------------------------
// Retry feedback prompt builder
// ---------------------------------------------------------------------------

describe("buildStructuredOutputRetryFeedback", () => {
  it("includes the tag name so the agent knows which block to re-emit", () => {
    const err = new StructuredOutputError("Tag <foo> not found", {
      tag: "foo",
      rawMatched: undefined,
      commits: [],
      branch: "main",
    });
    expect(buildStructuredOutputRetryFeedback(err, 2)).toContain("<foo>");
  });

  it("includes the error message so the agent has a diagnosis", () => {
    const err = new StructuredOutputError("contains invalid JSON", {
      tag: "result",
      rawMatched: "not valid json",
      cause: new SyntaxError("Unexpected token n in JSON"),
      commits: [],
      branch: "main",
    });
    const feedback = buildStructuredOutputRetryFeedback(err, 1);
    expect(feedback).toContain("contains invalid JSON");
  });

  it("includes the previous matched output so the agent can self-correct", () => {
    const err = new StructuredOutputError("invalid", {
      tag: "result",
      rawMatched: "broken {{}}",
      commits: [],
      branch: "main",
    });
    expect(buildStructuredOutputRetryFeedback(err, 0)).toContain("broken {{}}");
  });

  it("falls back to a placeholder when no tag was matched", () => {
    const err = new StructuredOutputError("Tag not found", {
      tag: "x",
      rawMatched: undefined,
      commits: [],
      branch: "main",
    });
    expect(buildStructuredOutputRetryFeedback(err, 0)).toContain(
      "no matching tag",
    );
  });

  it("reports how many retries remain after this attempt", () => {
    const err = new StructuredOutputError("bad", {
      tag: "x",
      rawMatched: undefined,
      commits: [],
      branch: "main",
    });
    expect(buildStructuredOutputRetryFeedback(err, 3)).toContain(
      "Retries remaining after this attempt: 3",
    );
  });

  it("instructs the agent not to change files (just re-emit)", () => {
    const err = new StructuredOutputError("bad", {
      tag: "x",
      rawMatched: undefined,
      commits: [],
      branch: "main",
    });
    const feedback = buildStructuredOutputRetryFeedback(err, 0);
    expect(feedback).toContain("Do not change files");
  });

  it("serialises a structured cause as readable JSON", () => {
    const err = new StructuredOutputError("schema failed", {
      tag: "x",
      rawMatched: '{"y":1}',
      cause: [{ message: "expected string" }],
      commits: [],
      branch: "main",
    });
    expect(buildStructuredOutputRetryFeedback(err, 1)).toContain(
      "expected string",
    );
  });
});

// ---------------------------------------------------------------------------
// Structured output retry — end-to-end (issue #825)
// ---------------------------------------------------------------------------

describe("output.maxRetries end-to-end", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  /** Pre-seed a Claude session JSONL on disk so `assertResumeSessionExists`
   *  passes when run() recurses with `resumeSession`. */
  const seedSessionFile = (
    hostProjectsDir: string,
    hostRepoDir: string,
    sessionId: string,
  ) => {
    const path = claudeHostSessionPath(hostRepoDir, sessionId, hostProjectsDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ type: "system", cwd: hostRepoDir })}\n`,
    );
  };

  /** Build a stateful bind-mount sandbox whose agent exec emits a different
   *  stream on each call. Each entry is the (line-by-line) JSONL stream for
   *  that invocation. Only execs that pass `onLine` (the agent invocation)
   *  advance the stage cursor — git setup execs do not. */
  const stagedAgentSandbox = (stages: string[][]) => {
    let agentCallCount = 0;
    return createBindMountSandboxProvider({
      name: "staged-agent",
      create: async () => ({
        worktreePath: process.cwd(),
        exec: async (
          _command: string,
          options?: { onLine?: (line: string) => void },
        ) => {
          if (options?.onLine) {
            const stage = stages[agentCallCount];
            agentCallCount += 1;
            if (stage) {
              for (const line of stage) {
                options.onLine(line);
              }
            }
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });
  };

  it("retries once on bad JSON, succeeds on resumed second attempt", async () => {
    const hostProjectsDir = mkdtempSync(join(tmpdir(), "sandcastle-retry-"));
    const sessionId = "sess-retry-1";
    seedSessionFile(hostProjectsDir, process.cwd(), sessionId);

    const sandbox = stagedAgentSandbox([
      [
        `{"type":"system","subtype":"init","session_id":"${sessionId}"}`,
        '{"type":"result","result":"<result>not valid json</result>"}',
      ],
      [
        `{"type":"system","subtype":"init","session_id":"${sessionId}"}`,
        String.raw`{"type":"result","result":"<result>{\"answer\":42}</result>"}`,
      ],
    ]);

    try {
      const result = await run({
        agent: claudeCode("claude-opus-4-8", {
          captureSessions: false,
          sessionStorage: { hostProjectsDir },
        }),
        sandbox,
        prompt: "emit your answer inside <result> tags",
        branchStrategy: { type: "head" },
        output: Output.object({
          tag: "result",
          schema: mockSchema(),
          maxRetries: 1,
        }),
      });
      expect(result.output).toStrictEqual({ answer: 42 });
    } finally {
      rmSync(hostProjectsDir, { recursive: true, force: true });
    }
  });

  it("throws the final StructuredOutputError when all retries are exhausted", async () => {
    const hostProjectsDir = mkdtempSync(join(tmpdir(), "sandcastle-retry-"));
    const sessionId = "sess-retry-2";
    seedSessionFile(hostProjectsDir, process.cwd(), sessionId);

    const badStage = [
      `{"type":"system","subtype":"init","session_id":"${sessionId}"}`,
      '{"type":"result","result":"<result>still not valid</result>"}',
    ];

    const sandbox = stagedAgentSandbox([badStage, badStage, badStage]);

    try {
      const promise = run({
        agent: claudeCode("claude-opus-4-8", {
          captureSessions: false,
          sessionStorage: { hostProjectsDir },
        }),
        sandbox,
        prompt: "emit your answer inside <result> tags",
        branchStrategy: { type: "head" },
        output: Output.object({
          tag: "result",
          schema: mockSchema(),
          maxRetries: 2,
        }),
      });
      await expect(promise).rejects.toBeInstanceOf(StructuredOutputError);
      await expect(promise).rejects.toMatchObject({
        rawMatched: "still not valid",
      });
    } finally {
      rmSync(hostProjectsDir, { recursive: true, force: true });
    }
  });

  it("does not retry when maxRetries is 0 (default behaviour)", async () => {
    const sandbox = stagedAgentSandbox([
      [
        `{"type":"system","subtype":"init","session_id":"sess-noretry"}`,
        '{"type":"result","result":"<result>oops</result>"}',
      ],
      [
        // Should never reach this stage — a stray success would mask a missing
        // guard around the recursion.
        `{"type":"system","subtype":"init","session_id":"sess-noretry"}`,
        String.raw`{"type":"result","result":"<result>{\"answer\":1}</result>"}`,
      ],
    ]);

    await expect(
      run({
        agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
        sandbox,
        prompt: "emit your answer inside <result> tags",
        branchStrategy: { type: "head" },
        output: Output.object({ tag: "result", schema: mockSchema() }),
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });
});

describe("merge-to-head temp branch name", () => {
  let hostDir: string;

  beforeEach(() => {
    hostDir = mkdtempSync(join(tmpdir(), "sandcastle-run-m2h-"));
    const git = (cmd: string) =>
      execSync(`git ${cmd}`, { cwd: hostDir, stdio: "ignore" });
    git("init -b main");
    git('config user.email "test@test.com"');
    git('config user.name "Test"');
    writeFileSync(join(hostDir, "README.md"), "# Test\n");
    git("add .");
    git('commit -m "initial"');
  });

  afterEach(() => {
    rmSync(hostDir, { recursive: true, force: true });
  });

  // Runs sandbox commands on the host, in the worktree Sandcastle created.
  const hostWorktreeSandbox = createBindMountSandboxProvider({
    name: "host-worktree",
    create: async (options) => ({
      worktreePath: options.worktreePath,
      exec: async (command) => {
        const stdout = execSync(command, {
          cwd: options.worktreePath,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { stdout, stderr: "", exitCode: 0 };
      },
      copyFileIn: async () => {},
      copyFileOut: async () => {},
      close: async () => {},
    }),
  });

  it("uses one name for the log file, {{SOURCE_BRANCH}} and the branch the agent works on", async () => {
    const promptPath = join(hostDir, "prompt.md");
    writeFileSync(
      promptPath,
      "SOURCE={{SOURCE_BRANCH}} ACTUAL=!`git rev-parse --abbrev-ref HEAD`",
    );
    let agentPrompt: string | undefined;
    const recordingAgent: AgentProvider = {
      name: "recording",
      env: {},
      captureSessions: false,
      buildPrintCommand: ({ prompt }) => {
        agentPrompt = prompt;
        return { command: "true" };
      },
      parseStreamLine: () => [],
    };
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await run({
        agent: recordingAgent,
        sandbox: hostWorktreeSandbox,
        promptFile: promptPath,
        cwd: hostDir,
        branchStrategy: { type: "merge-to-head" },
      });

      const match = agentPrompt?.match(/^SOURCE=(\S+) ACTUAL=(\S+)$/);
      assert.exists(match);
      const [, sourceBranch, actualBranch] = match;
      assert.isDefined(actualBranch);
      expect(actualBranch).toMatch(/^sandcastle\//);
      expect(sourceBranch).toBe(actualBranch);
      expect(result.logFilePath).toBe(
        join(
          hostDir,
          ".sandcastle",
          "logs",
          buildLogFilename(actualBranch, "main"),
        ),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("resume/fork after a promptFile + promptArgs run", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("runs the follow-up prompt inline, without the original promptArgs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-resume-args-"));
    const hostProjectsDir = join(dir, "projects");
    const sessionId = "sess-resume-args";
    const sessionPath = claudeHostSessionPath(
      process.cwd(),
      sessionId,
      hostProjectsDir,
    );
    mkdirSync(dirname(sessionPath), { recursive: true });
    writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: "system", cwd: process.cwd() })}\n`,
    );
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "Remember {{TOKEN}}");

    const agentStdin: (string | undefined)[] = [];
    const sandbox = createBindMountSandboxProvider({
      name: "resume-args",
      create: async () => ({
        worktreePath: process.cwd(),
        exec: async (
          _command: string,
          options?: { onLine?: (line: string) => void; stdin?: string },
        ) => {
          if (options?.onLine) {
            agentStdin.push(options.stdin);
            options.onLine(
              `{"type":"system","subtype":"init","session_id":"${sessionId}"}`,
            );
            options.onLine('{"type":"result","result":"ok"}');
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    try {
      const first = await run({
        agent: claudeCode("claude-opus-4-8", {
          captureSessions: false,
          sessionStorage: { hostProjectsDir },
        }),
        sandbox,
        promptFile,
        promptArgs: { TOKEN: "tok-123" },
        branchStrategy: { type: "head" },
        logging: { type: "file", path: join(dir, "run.log") },
      });

      assert.isDefined(first.resume);
      assert.isDefined(first.fork);
      const resumed = await first.resume("repeat {{TOKEN}}");
      const forked = await first.fork("fork {{TOKEN}}");

      expect(resumed.iterations).toHaveLength(1);
      expect(forked.iterations).toHaveLength(1);
      // The follow-up prompts are inline: passed as-is, never substituted.
      expect(agentStdin).toStrictEqual([
        "Remember tok-123",
        "repeat {{TOKEN}}",
        "fork {{TOKEN}}",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resume/fork after a structured-output run", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-resume-output-"));
    const hostProjectsDir = join(dir, "projects");
    const sessionId = "sess-resume-output";
    const sessionPath = claudeHostSessionPath(
      process.cwd(),
      sessionId,
      hostProjectsDir,
    );
    mkdirSync(dirname(sessionPath), { recursive: true });
    writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: "system", cwd: process.cwd() })}\n`,
    );

    const agentStdin: (string | undefined)[] = [];
    const sandbox = createBindMountSandboxProvider({
      name: "resume-output",
      create: async () => ({
        worktreePath: process.cwd(),
        exec: async (
          _command: string,
          options?: { onLine?: (line: string) => void; stdin?: string },
        ) => {
          if (options?.onLine) {
            agentStdin.push(options.stdin);
            options.onLine(
              `{"type":"system","subtype":"init","session_id":"${sessionId}"}`,
            );
            options.onLine(
              '{"type":"result","result":"<summary>all good</summary>"}',
            );
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const first = async () =>
      run({
        agent: claudeCode("claude-opus-4-8", {
          captureSessions: false,
          sessionStorage: { hostProjectsDir },
        }),
        sandbox,
        prompt: "Summarise inside <summary> tags",
        branchStrategy: { type: "head" },
        logging: { type: "file", path: join(dir, "run.log") },
        output: Output.string({ tag: "summary" }),
      });

    return { dir, agentStdin, first };
  };

  it("does not carry output into a follow-up whose prompt lacks the tag", async () => {
    const { dir, agentStdin, first } = setup();
    try {
      const r = await first();
      expect(r.output).toBe("all good");

      assert.isDefined(r.resume);
      assert.isDefined(r.fork);
      const resumed = await r.resume("write the word DONE into done.txt");
      const forked = await r.fork("write the word DONE into done.txt");

      expect(resumed.iterations).toHaveLength(1);
      expect(forked.iterations).toHaveLength(1);
      expect("output" in resumed).toBe(false);
      expect("output" in forked).toBe(false);
      expect(agentStdin).toStrictEqual([
        "Summarise inside <summary> tags",
        "write the word DONE into done.txt",
        "write the word DONE into done.txt",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still extracts output when the follow-up passes it explicitly", async () => {
    const { dir, first } = setup();
    try {
      const r = await first();
      assert.isDefined(r.resume);
      assert.isDefined(r.fork);
      const resumed = (await r.resume("Summarise again in <summary> tags", {
        output: Output.string({ tag: "summary" }),
      })) as { output?: unknown };
      expect(resumed.output).toBe("all good");

      await expect(
        r.fork("no tag here", { output: Output.string({ tag: "summary" }) }),
      ).rejects.toThrow(/output tag <summary> not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fork on an agent provider that resumes but cannot fork", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("copilot: fork() throws ForkNotSupportedError naming copilot, before any sandbox starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-copilot-fork-"));
    const sessionId = "9f2885bc-f7a6-44ad-8c8e-4e22ca99fa26";
    let creates = 0;
    const sandbox = createBindMountSandboxProvider({
      name: "copilot-fork",
      create: async () => {
        creates++;
        return {
          worktreePath: process.cwd(),
          exec: async (
            _command: string,
            options?: { onLine?: (line: string) => void },
          ) => {
            options?.onLine?.(
              JSON.stringify({
                type: "assistant.message",
                data: { content: "OK" },
              }),
            );
            options?.onLine?.(
              JSON.stringify({ type: "result", sessionId, exitCode: 0 }),
            );
            return { stdout: "", stderr: "", exitCode: 0 };
          },
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {},
        };
      },
    });

    try {
      const first = await run({
        agent: copilot("claude-haiku-4.5", { captureSessions: false }),
        sandbox,
        prompt: "remember a token",
        branchStrategy: { type: "head" },
        logging: { type: "file", path: join(dir, "run.log") },
      });
      expect(first.iterations[0]?.sessionId).toBe(sessionId);
      expect(creates).toBe(1);

      const forked = first.fork?.("fork it");
      await expect(forked).rejects.toBeInstanceOf(ForkNotSupportedError);
      await expect(forked).rejects.toMatchObject({
        name: "ForkNotSupportedError",
        agentProvider: "copilot",
      });
      await expect(forked).rejects.toThrow(/copilot cannot fork/u);
      expect(creates).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cursor: fork() throws ForkNotSupportedError naming cursor, before any sandbox starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-cursor-fork-"));
    const sessionId = "dd42b549-290c-4635-b058-04801905e8cf";
    let creates = 0;
    const sandbox = createBindMountSandboxProvider({
      name: "cursor-fork",
      create: async () => {
        creates++;
        return {
          worktreePath: process.cwd(),
          exec: async (
            _command: string,
            options?: { onLine?: (line: string) => void },
          ) => {
            options?.onLine?.(
              JSON.stringify({
                type: "system",
                subtype: "init",
                session_id: sessionId,
              }),
            );
            options?.onLine?.(JSON.stringify({ type: "result", result: "OK" }));
            return { stdout: "", stderr: "", exitCode: 0 };
          },
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {},
        };
      },
    });

    try {
      const first = await run({
        agent: cursor("composer-2", { captureSessions: false }),
        sandbox,
        prompt: "remember a code word",
        branchStrategy: { type: "head" },
        logging: { type: "file", path: join(dir, "run.log") },
      });
      expect(first.iterations[0]?.sessionId).toBe(sessionId);
      expect(creates).toBe(1);

      const forked = first.fork?.("fork it");
      await expect(forked).rejects.toBeInstanceOf(ForkNotSupportedError);
      await expect(forked).rejects.toMatchObject({
        name: "ForkNotSupportedError",
        agentProvider: "cursor",
      });
      await expect(forked).rejects.toThrow(/cursor cannot fork/u);
      expect(creates).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
