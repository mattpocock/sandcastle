import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildCompletionMessage,
  buildContextWindowLines,
  buildLogFilename,
  buildRunSummaryRows,
  DEFAULT_MAX_ITERATIONS,
  formatContextWindowSize,
  printFileDisplayStartup,
  run,
  sanitizeBranchForFilename,
  type RunOptions,
  type RunResult,
} from "./run.js";
import { claudeCode } from "./AgentProvider.js";
import { Output, StructuredOutputError } from "./Output.js";
import type { InteractiveOptions } from "./interactive.js";
import type { WorktreeInteractiveOptions } from "./createWorktree.js";
import { defaultImageName } from "./sandboxes/docker.js";
import * as sandcastle from "./SandboxProvider.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";

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
    expect(allOutput).toContain("\u001b[1m");
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
    expect(result.iterations.length).toBe(2);
    expect(result.iterations[0]!.sessionId).toBe("abc-123");
    expect(result.iterations[1]!.sessionId).toBe("def-456");
  });

  it("has undefined sessionId for non-Claude agent iterations", () => {
    const result: RunResult = {
      iterations: [{ sessionId: undefined }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.iterations[0]!.sessionId).toBeUndefined();
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
    expect(result.iterations[0]!.sessionFilePath).toContain("abc-123.jsonl");
  });

  it("has undefined sessionFilePath when capture is disabled", () => {
    const result: RunResult = {
      iterations: [{ sessionId: "abc-123", sessionFilePath: undefined }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.iterations[0]!.sessionFilePath).toBeUndefined();
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
      agent: claudeCode("claude-opus-4-7"),
      prompt: "test",
    };
  });

  it("allows idleTimeoutSeconds to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "test",
      idleTimeoutSeconds: 120,
    };
    expect(opts.idleTimeoutSeconds).toBe(120);
  });

  it("allows idleTimeoutSeconds to be omitted (uses default)", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.idleTimeoutSeconds).toBeUndefined();
  });

  it("allows name to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "test",
      name: "my-run",
    };
    expect(opts.name).toBe("my-run");
  });

  it("allows name to be omitted", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.name).toBeUndefined();
  });

  it("does not accept a worktree field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error worktree is no longer a valid field on RunOptions
    expect(opts.worktree).toBeUndefined();
  });

  it("allows cwd to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "test",
      cwd: "/some/repo",
    };
    expect(opts.cwd).toBe("/some/repo");
  });

  it("allows cwd to be omitted (defaults to process.cwd())", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.cwd).toBeUndefined();
  });

  it("does not accept a top-level branch field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error branch is no longer a valid field on RunOptions
    expect(opts.branch).toBeUndefined();
  });

  it("does not accept a top-level imageName field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
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
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "test",
      signal: ac.signal,
    };
    expect(opts.signal).toBe(ac.signal);
  });

  it("allows signal to be omitted", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
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
        agent: claudeCode("claude-opus-4-7"),
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
    try {
      await run({
        agent: claudeCode("claude-opus-4-7"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        signal: ac.signal,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(reason);
    }
  });
});

describe("resumeSession validation", () => {
  it("throws when resumeSession is set with maxIterations > 1", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-7"),
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
        agent: claudeCode("claude-opus-4-7"),
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
        agent: claudeCode("claude-opus-4-7"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        resumeSession: "abc-123",
      }),
    ).rejects.toThrow('resumeSession "abc-123" not found');
  });
});

describe("copyToWorktree with head branch strategy", () => {
  it("throws a runtime error when copyToWorktree is provided with head strategy", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-7"),
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
        agent: claudeCode("claude-opus-4-7"),
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
    expect(sanitizeBranchForFilename("feature\\branch")).toBe("feature-branch");
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
        agent: claudeCode("claude-opus-4-7"),
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
        agent: claudeCode("claude-opus-4-7"),
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
    // The run still fails (fake sandbox can't actually run the agent) but the
    // failure must not be a prompt-substitution error.
    const promise = run({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "Issue body mentions {{BRANCH}} in its content.",
      branchStrategy: { type: "head" },
    });

    await promise.catch((err: Error) => {
      expect(err.message).not.toContain("matching value in promptArgs");
      expect(err.message).not.toContain("{{BRANCH}}");
    });
  });

  it("accepts inline prompt with empty promptArgs ({})", async () => {
    // Spreading `...opts` where `opts.promptArgs` defaults to {} is a common
    // pattern. An empty args object is semantically the same as "not provided"
    // and must not trigger the inline-prompt guard.
    const promise = run({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "do the work",
      branchStrategy: { type: "head" },
      promptArgs: {},
    });

    await promise.catch((err: Error) => {
      expect(err.message).not.toContain(
        "promptArgs is only supported with promptFile",
      );
    });
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
        agent: claudeCode("claude-opus-4-7"),
        sandbox: testSandbox,
        promptFile,
        branchStrategy: { type: "head" },
        promptArgs: { SOURCE_BRANCH: "override" },
        logging: { type: "file", path: logPath },
      }),
    ).rejects.toThrow();

    const log = readFileSync(logPath, "utf-8");
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
        agent: claudeCode("claude-opus-4-7"),
        sandbox: testSandbox,
        promptFile,
        branchStrategy: { type: "head" },
        promptArgs: { SOURCE_BRANCH: "override" },
        logging: { type: "file", path: logPath },
      }),
    ).rejects.toThrow("SOURCE_BRANCH");
  });
});

describe("formatContextWindowSize", () => {
  it("rounds up to the nearest 1000 tokens", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 102400,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("103k");
  });

  it("returns exact k value when total is a multiple of 1000", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 100000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("100k");
  });

  it("rounds 100001 up to 101k", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 100001,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("101k");
  });

  it("rounds 1 up to 1k", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("1k");
  });

  it("rounds 999 up to 1k", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 999,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("1k");
  });

  it("returns 1k for exactly 1000", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 1000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("1k");
  });

  it("rounds 1001 up to 2k", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 1001,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("2k");
  });

  it("sums inputTokens, cacheCreationInputTokens, and cacheReadInputTokens", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 50000,
        cacheCreationInputTokens: 25000,
        cacheReadInputTokens: 25000,
        outputTokens: 9999,
      }),
    ).toBe("100k");
  });

  it("rounds 99500 up to 100k", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 99500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("100k");
  });
});

describe("buildContextWindowLines", () => {
  it("returns one line per iteration with usage data", () => {
    const lines = buildContextWindowLines([
      {
        usage: {
          inputTokens: 50000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1000,
        },
      },
      {
        usage: {
          inputTokens: 100000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 2000,
        },
      },
    ]);
    expect(lines).toEqual(["Context window: 50k", "Context window: 100k"]);
  });

  it("skips iterations without usage data", () => {
    const lines = buildContextWindowLines([
      {
        usage: {
          inputTokens: 50000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1000,
        },
      },
      {},
      {
        usage: {
          inputTokens: 100000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 2000,
        },
      },
    ]);
    expect(lines).toEqual(["Context window: 50k", "Context window: 100k"]);
  });

  it("returns empty array when no iterations have usage", () => {
    const lines = buildContextWindowLines([{}, {}, {}]);
    expect(lines).toEqual([]);
  });

  it("returns empty array for empty iterations list", () => {
    const lines = buildContextWindowLines([]);
    expect(lines).toEqual([]);
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
        agent: claudeCode("claude-opus-4-7"),
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
        agent: claudeCode("claude-opus-4-7"),
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
        agent: claudeCode("claude-opus-4-7"),
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
        agent: claudeCode("claude-opus-4-7"),
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
        agent: claudeCode("claude-opus-4-7"),
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
        agent: claudeCode("claude-opus-4-7"),
        sandbox: testSandbox,
        promptFile,
        branchStrategy: { type: "head" },
        output: Output.object({ tag: "answer", schema: mockSchema() }),
      }),
    ).rejects.toThrow("output tag <answer> not found in the resolved prompt");
  });
});

describe("RunOptions with output", () => {
  it("allows output field on RunOptions", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "emit <result>...</result>",
      output: Output.object({ tag: "result", schema: mockSchema() }),
    };
    expect(opts.output).toBeDefined();
  });

  it("allows output to be omitted", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-7"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.output).toBeUndefined();
  });
});

describe("output type-level exclusion", () => {
  it("InteractiveOptions does not accept output", () => {
    const opts: InteractiveOptions = {
      agent: claudeCode("claude-opus-4-7"),
      prompt: "test",
    };
    // @ts-expect-error output is not a field on InteractiveOptions
    expect(opts.output).toBeUndefined();
  });

  it("WorktreeInteractiveOptions does not accept output", () => {
    const opts: WorktreeInteractiveOptions = {
      agent: claudeCode("claude-opus-4-7"),
      prompt: "test",
    };
    // @ts-expect-error output is not a field on WorktreeInteractiveOptions
    expect(opts.output).toBeUndefined();
  });
});
