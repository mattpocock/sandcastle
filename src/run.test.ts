import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildCompletionMessage,
  buildLogFilename,
  buildRunSummaryRows,
  DEFAULT_MAX_ITERATIONS,
  defaultImageName,
  printFileDisplayStartup,
  sanitizeBranchForFilename,
  type RunOptions,
  type RunResult,
} from "./run.js";

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
      iterationsRun: 1,
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
      iterationsRun: 1,
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.logFilePath).toBeUndefined();
  });
});

describe("DEFAULT_MAX_ITERATIONS", () => {
  it("is 1", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(1);
  });
});

describe("RunOptions", () => {
  it("defaults agent to undefined when not specified", () => {
    const opts: RunOptions = { prompt: "test" };
    expect(opts.agent).toBeUndefined();
  });

  it("allows agent to be specified", () => {
    const opts: RunOptions = { prompt: "test", agent: "pi" };
    expect(opts.agent).toBe("pi");
  });

  it("allows agent to be specified as codex", () => {
    const opts: RunOptions = { prompt: "test", agent: "codex" };
    expect(opts.agent).toBe("codex");
  });

  it("allows idleTimeoutSeconds to be specified", () => {
    const opts: RunOptions = { prompt: "test", idleTimeoutSeconds: 120 };
    expect(opts.idleTimeoutSeconds).toBe(120);
  });

  it("allows idleTimeoutSeconds to be omitted (uses default)", () => {
    const opts: RunOptions = { prompt: "test" };
    expect(opts.idleTimeoutSeconds).toBeUndefined();
  });

  it("allows name to be specified", () => {
    const opts: RunOptions = { prompt: "test", name: "my-run" };
    expect(opts.name).toBe("my-run");
  });

  it("allows name to be omitted", () => {
    const opts: RunOptions = { prompt: "test" };
    expect(opts.name).toBeUndefined();
  });
});

describe("buildRunSummaryRows", () => {
  it("uses the custom name as Agent when name is provided", () => {
    const rows = buildRunSummaryRows({
      name: "Implementer #202",
      agentName: "claude-code",
      imageName: "sandcastle:myrepo",
      maxIterations: 3,
      branch: "main",
    });
    expect(rows["Agent"]).toBe("Implementer #202");
  });

  it("falls back to agentName when no name is provided", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      imageName: "sandcastle:myrepo",
      maxIterations: 1,
      branch: "main",
    });
    expect(rows["Agent"]).toBe("claude-code");
  });

  it("includes image, max iterations, and branch", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      imageName: "sandcastle:myrepo",
      maxIterations: 5,
      branch: "sandcastle/issue-160",
    });
    expect(rows["Image"]).toBe("sandcastle:myrepo");
    expect(rows["Max iterations"]).toBe("5");
    expect(rows["Branch"]).toBe("sandcastle/issue-160");
  });

  it("includes model when provided", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      imageName: "sandcastle:myrepo",
      maxIterations: 1,
      branch: "main",
      model: "claude-opus-4-6",
    });
    expect(rows["Model"]).toBe("claude-opus-4-6");
  });

  it("omits model when not provided", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      imageName: "sandcastle:myrepo",
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
