import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const mockText = vi.fn();
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    text: (...args: unknown[]) => mockText(...args),
  };
});

import { interactive } from "./interactive.js";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type InteractiveExecOptions,
} from "./SandboxProvider.js";
import { claudeCode } from "./AgentProvider.js";

describe("interactive arg collection", () => {
  let hostDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    hostDir = mkdtempSync(join(tmpdir(), "sandcastle-interactive-argcol-"));
    execSync("git init", { cwd: hostDir, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', {
      cwd: hostDir,
      stdio: "ignore",
    });
    execSync('git config user.name "Test"', {
      cwd: hostDir,
      stdio: "ignore",
    });
    writeFileSync(join(hostDir, "README.md"), "# Test\n");
    execSync("git add .", { cwd: hostDir, stdio: "ignore" });
    execSync('git commit -m "initial"', { cwd: hostDir, stdio: "ignore" });
    process.chdir(hostDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.clearAllMocks();
  });

  let promptFileCounter = 0;
  const writePrompt = (text: string): string => {
    const path = join(hostDir, `argcol-prompt-${promptFileCounter++}.md`);
    writeFileSync(path, text);
    return path;
  };

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

  it("prompts for missing {{KEY}} placeholders and substitutes them", async () => {
    mockText.mockResolvedValueOnce("LoginForm");
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptFile: writePrompt("Fix bug in {{COMPONENT}}"),
    });

    expect(mockText).toHaveBeenCalledOnce();
    expect(mockText).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter value for {{COMPONENT}}" }),
    );
    const promptArg = receivedArgs[receivedArgs.length - 1]!;
    expect(promptArg).toContain("LoginForm");
    expect(promptArg).not.toContain("{{COMPONENT}}");
  });

  it("skips prompting when all args are provided", async () => {
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptFile: writePrompt("Fix bug in {{COMPONENT}}"),
      promptArgs: { COMPONENT: "LoginForm" },
    });

    expect(mockText).not.toHaveBeenCalled();
    const promptArg = receivedArgs[receivedArgs.length - 1]!;
    expect(promptArg).toContain("LoginForm");
  });

  it("skips prompting when prompt has no placeholders", async () => {
    const provider = makeTestProvider(async () => ({ exitCode: 0 }));

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptFile: writePrompt("A plain prompt with no placeholders"),
    });

    expect(mockText).not.toHaveBeenCalled();
  });

  it("does not prompt for built-in args SOURCE_BRANCH and TARGET_BRANCH", async () => {
    const provider = makeTestProvider(async () => ({ exitCode: 0 }));

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptFile: writePrompt(
        "Branch {{SOURCE_BRANCH}} target {{TARGET_BRANCH}}",
      ),
    });

    expect(mockText).not.toHaveBeenCalled();
  });

  it("prompts for multiple missing keys in order", async () => {
    mockText.mockResolvedValueOnce("LoginForm").mockResolvedValueOnce("42");
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptFile: writePrompt("Fix {{COMPONENT}} issue #{{ISSUE_NUM}}"),
    });

    expect(mockText).toHaveBeenCalledTimes(2);
    expect(mockText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: "Enter value for {{COMPONENT}}" }),
    );
    expect(mockText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "Enter value for {{ISSUE_NUM}}" }),
    );
    const promptArg = receivedArgs[receivedArgs.length - 1]!;
    expect(promptArg).toContain("LoginForm");
    expect(promptArg).toContain("42");
  });

  it("merges collected args with provided args", async () => {
    mockText.mockResolvedValueOnce("42");
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptFile: writePrompt("Fix {{COMPONENT}} issue #{{ISSUE_NUM}}"),
      promptArgs: { COMPONENT: "LoginForm" },
    });

    // Only ISSUE_NUM should be prompted (COMPONENT was provided)
    expect(mockText).toHaveBeenCalledOnce();
    const promptArg = receivedArgs[receivedArgs.length - 1]!;
    expect(promptArg).toContain("LoginForm");
    expect(promptArg).toContain("42");
  });
});
