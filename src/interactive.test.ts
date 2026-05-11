import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { interactive, type InteractiveOptions } from "./interactive.js";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type InteractiveExecOptions,
} from "./SandboxProvider.js";
import { claudeCode, pi, codex, opencode } from "./AgentProvider.js";

// --- buildInteractiveArgs prompt tests ---

const interactiveOpts = (prompt: string) => ({
  prompt,
  dangerouslySkipPermissions: true,
});

describe("buildInteractiveArgs with prompts", () => {
  it("claudeCode includes prompt as positional argument", () => {
    const provider = claudeCode("claude-opus-4-7");
    const args = provider.buildInteractiveArgs!(interactiveOpts("fix the bug"));
    expect(args[0]).toBe("claude");
    expect(args[args.length - 1]).toBe("fix the bug");
  });

  it("claudeCode omits prompt when empty string", () => {
    const provider = claudeCode("claude-opus-4-7");
    const args = provider.buildInteractiveArgs!(interactiveOpts(""));
    expect(args[args.length - 1]).not.toBe("");
    expect(args).toContain("--model");
  });

  it("pi includes prompt as positional argument", () => {
    const provider = pi("claude-sonnet-4-6");
    const args = provider.buildInteractiveArgs!(interactiveOpts("fix the bug"));
    expect(args[0]).toBe("pi");
    expect(args[args.length - 1]).toBe("fix the bug");
  });

  it("pi omits prompt when empty string", () => {
    const provider = pi("claude-sonnet-4-6");
    const args = provider.buildInteractiveArgs!(interactiveOpts(""));
    expect(args).not.toContain("");
  });

  it("codex includes prompt as positional argument", () => {
    const provider = codex("gpt-5.4-mini");
    const args = provider.buildInteractiveArgs!(interactiveOpts("fix the bug"));
    expect(args[0]).toBe("codex");
    expect(args[args.length - 1]).toBe("fix the bug");
  });

  it("codex omits prompt when empty string", () => {
    const provider = codex("gpt-5.4-mini");
    const args = provider.buildInteractiveArgs!(interactiveOpts(""));
    expect(args).not.toContain("");
  });

  it("opencode passes prompt via -p flag", () => {
    const provider = opencode("opencode/big-pickle");
    const args = provider.buildInteractiveArgs!(interactiveOpts("fix the bug"));
    expect(args[0]).toBe("opencode");
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("fix the bug");
  });

  it("opencode omits -p flag when prompt is empty", () => {
    const provider = opencode("opencode/big-pickle");
    const args = provider.buildInteractiveArgs!(interactiveOpts(""));
    expect(args).not.toContain("-p");
  });
});

// --- interactive() function tests ---

describe("interactive()", () => {
  let hostDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    hostDir = mkdtempSync(join(tmpdir(), "sandcastle-interactive-test-"));
    // Initialize a git repo
    execSync("git init", { cwd: hostDir, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', {
      cwd: hostDir,
      stdio: "ignore",
    });
    execSync('git config user.name "Test"', {
      cwd: hostDir,
      stdio: "ignore",
    });
    // Create initial commit
    writeFileSync(join(hostDir, "README.md"), "# Test\n");
    execSync("git add .", { cwd: hostDir, stdio: "ignore" });
    execSync('git commit -m "initial"', { cwd: hostDir, stdio: "ignore" });
    process.chdir(hostDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  /**
   * Create a test bind-mount provider with a fake interactiveExec.
   * The fakeInteractiveExec callback simulates an interactive session.
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

  it("returns InteractiveResult with exitCode, branch, and commits", async () => {
    const provider = makeTestProvider(async (_args, _opts) => {
      return { exitCode: 0 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "test prompt",
      name: "test-session",
    });

    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("branch");
    expect(result).toHaveProperty("commits");
    expect(result.exitCode).toBe(0);
    expect(typeof result.branch).toBe("string");
    expect(Array.isArray(result.commits)).toBe(true);
  });

  it("passes prompt through buildInteractiveArgs to interactiveExec", async () => {
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "fix the login bug",
    });

    // Claude Code's buildInteractiveArgs should include the prompt
    expect(receivedArgs).toContain("fix the login bug");
    expect(receivedArgs[0]).toBe("claude");
  });

  it("collects commits made during the interactive session", async () => {
    const provider = makeTestProvider(async (_args, opts) => {
      // Simulate the agent making a commit inside the sandbox
      const cwd = opts.cwd!;
      execSync('echo "new content" > newfile.txt', { cwd });
      execSync("git add newfile.txt", { cwd });
      execSync('git commit -m "agent commit"', { cwd });
      return { exitCode: 0 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "add a file",
    });

    expect(result.commits.length).toBe(1);
    expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns non-zero exitCode from the interactive session", async () => {
    const provider = makeTestProvider(async () => {
      return { exitCode: 42 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "test",
    });

    expect(result.exitCode).toBe(42);
  });

  it("throws when provider does not implement interactiveExec", async () => {
    const provider = createBindMountSandboxProvider({
      name: "no-interactive",
      create: async (options) => ({
        worktreePath: options.worktreePath,
        exec: async (command) => {
          const result = execSync(command, {
            cwd: options.worktreePath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { stdout: result, stderr: "", exitCode: 0 };
        },
        // No interactiveExec
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    await expect(
      interactive({
        agent: claudeCode("claude-opus-4-7"),
        sandbox: provider,
        prompt: "test",
      }),
    ).rejects.toThrow("interactiveExec");
  });

  it("throws when provider is isolated (not bind-mount)", async () => {
    const { createIsolatedSandboxProvider } =
      await import("./SandboxProvider.js");
    const isolatedProvider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => ({
        worktreePath: "/workspace",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    // Isolated provider with default strategy (merge-to-head) should work in principle,
    // but head strategy is not supported
    await expect(
      interactive({
        agent: claudeCode("claude-opus-4-7"),
        sandbox: isolatedProvider,
        prompt: "test",
        branchStrategy: { type: "head" },
      }),
    ).rejects.toThrow("head branch strategy is not supported with isolated");
  });

  it("receives stdin/stdout/stderr streams in interactiveExec options", async () => {
    let receivedOpts: InteractiveExecOptions | undefined;

    const provider = makeTestProvider(async (_args, opts) => {
      receivedOpts = opts;
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "test",
    });

    expect(receivedOpts).toBeDefined();
    expect(receivedOpts!.stdin).toBe(process.stdin);
    expect(receivedOpts!.stdout).toBe(process.stdout);
    expect(receivedOpts!.stderr).toBe(process.stderr);
    expect(receivedOpts!.cwd).toBeDefined();
  });

  // --- No-prompt tests ---

  it("launches without prompt when neither prompt nor promptFile is provided", async () => {
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
    });

    expect(result.exitCode).toBe(0);
    // Should have called interactiveExec with args from buildInteractiveArgs (empty prompt)
    expect(receivedArgs[0]).toBe("claude");
    // Prompt should not appear in args (empty string is omitted by buildInteractiveArgs)
    expect(receivedArgs[receivedArgs.length - 1]).not.toBe("");
  });

  it("skips promptArgs substitution when no prompt is provided", async () => {
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    // This should NOT throw even though promptArgs has keys — there's no prompt to substitute into
    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptArgs: { COMPONENT: "LoginForm" },
    });

    expect(result.exitCode).toBe(0);
  });

  it("skips shell expression preprocessing when no prompt is provided", async () => {
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
    });

    expect(result.exitCode).toBe(0);
    // No prompt-related args should be in the command
    const joined = receivedArgs.join(" ");
    expect(joined).not.toContain("!`");
  });

  // --- Prompt preprocessing tests ---

  it("reads prompt from promptFile", async () => {
    const promptPath = join(hostDir, "test-prompt.md");
    writeFileSync(promptPath, "prompt from file");
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptFile: promptPath,
    });

    expect(receivedArgs).toContain("prompt from file");
  });

  it("throws when both prompt and promptFile are provided", async () => {
    const promptPath = join(hostDir, "test-prompt.md");
    writeFileSync(promptPath, "prompt from file");

    const provider = makeTestProvider(async () => ({ exitCode: 0 }));

    await expect(
      interactive({
        agent: claudeCode("claude-opus-4-7"),
        sandbox: provider,
        prompt: "inline prompt",
        promptFile: promptPath,
      }),
    ).rejects.toThrow("Cannot provide both");
  });

  it("substitutes {{KEY}} placeholders in prompts", async () => {
    const promptPath = join(hostDir, "substitute-prompt.md");
    writeFileSync(promptPath, "Fix bug in {{COMPONENT}}");
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptFile: promptPath,
      promptArgs: { COMPONENT: "LoginForm" },
    });

    // The substituted prompt should contain "LoginForm" not "{{COMPONENT}}"
    const promptArg = receivedArgs[receivedArgs.length - 1]!;
    expect(promptArg).toContain("LoginForm");
    expect(promptArg).not.toContain("{{COMPONENT}}");
  });

  it("substitutes built-in SOURCE_BRANCH and TARGET_BRANCH args", async () => {
    const promptPath = join(hostDir, "builtin-prompt.md");
    writeFileSync(promptPath, "Branch is {{TARGET_BRANCH}}");
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    // Get current branch name for verification
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: hostDir,
      encoding: "utf-8",
    }).trim();

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptFile: promptPath,
    });

    const promptArg = receivedArgs[receivedArgs.length - 1]!;
    expect(promptArg).toContain(currentBranch);
    expect(promptArg).not.toContain("{{TARGET_BRANCH}}");
  });

  it("expands shell expressions (!`command`) inside sandbox", async () => {
    const promptPath = join(hostDir, "shell-prompt.md");
    writeFileSync(
      promptPath,
      "Current branch: !`git rev-parse --abbrev-ref HEAD`",
    );
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      promptFile: promptPath,
    });

    // The shell expression should be expanded to the actual branch name
    const promptArg = receivedArgs[receivedArgs.length - 1]!;
    expect(promptArg).not.toContain("!`");
    // The expanded value should be a branch name (from the sandbox worktree)
    expect(promptArg).toMatch(/Current branch: .+/);
  });

  it("throws when built-in prompt arg is overridden", async () => {
    const promptPath = join(hostDir, "builtin-override-prompt.md");
    writeFileSync(promptPath, "test {{SOURCE_BRANCH}}");
    const provider = makeTestProvider(async () => ({ exitCode: 0 }));

    await expect(
      interactive({
        agent: claudeCode("claude-opus-4-7"),
        sandbox: provider,
        promptFile: promptPath,
        promptArgs: { SOURCE_BRANCH: "custom" },
      }),
    ).rejects.toThrow("SOURCE_BRANCH");
  });

  // --- Branch strategy tests ---

  it("head strategy: commits land on current branch directly", async () => {
    const provider = makeTestProvider(async (_args, opts) => {
      const cwd = opts.cwd!;
      execSync('echo "head change" > headfile.txt', { cwd });
      execSync("git add headfile.txt", { cwd });
      execSync('git commit -m "head commit"', { cwd });
      return { exitCode: 0 };
    });

    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: hostDir,
      encoding: "utf-8",
    }).trim();

    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "test",
      branchStrategy: { type: "head" },
    });

    expect(result.branch).toBe(currentBranch);
    expect(result.commits.length).toBe(1);
  });

  it("merge-to-head strategy: commits merge back to head", async () => {
    const provider = makeTestProvider(async (_args, opts) => {
      const cwd = opts.cwd!;
      execSync('echo "merge change" > mergefile.txt', { cwd });
      execSync("git add mergefile.txt", { cwd });
      execSync('git commit -m "merge commit"', { cwd });
      return { exitCode: 0 };
    });

    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: hostDir,
      encoding: "utf-8",
    }).trim();

    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "test",
      branchStrategy: { type: "merge-to-head" },
    });

    // Branch should be the host's current branch (temp branch was merged + deleted)
    expect(result.branch).toBe(currentBranch);
    expect(result.commits.length).toBe(1);

    // Verify the commit is on the current branch
    const log = execSync("git log --oneline -1", {
      cwd: hostDir,
      encoding: "utf-8",
    });
    expect(log).toContain("merge commit");
  });

  it("branch strategy: commits land on explicit branch", async () => {
    const provider = makeTestProvider(async (_args, opts) => {
      const cwd = opts.cwd!;
      execSync('echo "branch change" > branchfile.txt', { cwd });
      execSync("git add branchfile.txt", { cwd });
      execSync('git commit -m "branch commit"', { cwd });
      return { exitCode: 0 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "test",
      branchStrategy: { type: "branch", branch: "feature/test-branch" },
    });

    expect(result.branch).toBe("feature/test-branch");
    expect(result.commits.length).toBe(1);

    // Verify branch exists
    const branches = execSync("git branch", {
      cwd: hostDir,
      encoding: "utf-8",
    });
    expect(branches).toContain("feature/test-branch");
  });

  // --- Hooks tests ---

  it("runs onSandboxReady hooks before interactive session", async () => {
    const executionOrder: string[] = [];

    const provider = makeTestProvider(async (_args, opts) => {
      // Check if the hook file exists (created by the hook)
      const cwd = opts.cwd!;
      const hookFileExists = existsSync(join(cwd, "hook-ran.txt"));
      executionOrder.push(
        hookFileExists ? "interactive-after-hook" : "interactive-no-hook",
      );
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "test",
      hooks: {
        sandbox: {
          onSandboxReady: [{ command: "touch hook-ran.txt" }],
        },
      },
    });

    expect(executionOrder).toEqual(["interactive-after-hook"]);
  });

  // --- copyToWorktree tests ---

  it("throws when copyToWorktree used with head strategy", async () => {
    const provider = makeTestProvider(async () => ({ exitCode: 0 }));

    await expect(
      interactive({
        agent: claudeCode("claude-opus-4-7"),
        sandbox: provider,
        prompt: "test",
        branchStrategy: { type: "head" },
        copyToWorktree: ["node_modules"],
      }),
    ).rejects.toThrow("copyToWorktree is not supported with head");
  });

  // --- AbortSignal tests ---

  it("rejects immediately with pre-aborted signal without doing setup", async () => {
    const ac = new AbortController();
    ac.abort("cancelled before start");

    const provider = makeTestProvider(async () => {
      throw new Error("interactiveExec should not be called");
    });

    await expect(
      interactive({
        agent: claudeCode("claude-opus-4-7"),
        sandbox: provider,
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

    const provider = makeTestProvider(async () => {
      throw new Error("interactiveExec should not be called");
    });

    try {
      await interactive({
        agent: claudeCode("claude-opus-4-7"),
        sandbox: provider,
        prompt: "test",
        branchStrategy: { type: "head" },
        signal: ac.signal,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(reason);
    }
  });

  it("aborts an active interactive session when signal fires", async () => {
    const ac = new AbortController();

    const provider = makeTestProvider(async (_args, _opts) => {
      // Simulate a long-running interactive session
      return new Promise<{ exitCode: number }>((resolve) => {
        // Abort mid-session
        setTimeout(() => ac.abort("mid-session abort"), 50);
        // This would normally run for a long time
        setTimeout(() => resolve({ exitCode: 0 }), 10000);
      });
    });

    await expect(
      interactive({
        agent: claudeCode("claude-opus-4-7"),
        sandbox: provider,
        prompt: "test",
        branchStrategy: { type: "head" },
        signal: ac.signal,
      }),
    ).rejects.toThrow("mid-session abort");
  });

  it("allows signal to be omitted", () => {
    const opts: InteractiveOptions = {
      agent: claudeCode("claude-opus-4-7"),
      prompt: "test",
    };
    expect(opts.signal).toBeUndefined();
  });

  it("allows signal to be specified on InteractiveOptions", () => {
    const ac = new AbortController();
    const opts: InteractiveOptions = {
      agent: claudeCode("claude-opus-4-7"),
      prompt: "test",
      signal: ac.signal,
    };
    expect(opts.signal).toBe(ac.signal);
  });

  // --- cwd option tests ---

  it("uses cwd as host repo directory for worktree placement", async () => {
    // Create a second git repo in a separate temp dir
    const otherRepo = mkdtempSync(join(tmpdir(), "sandcastle-cwd-test-"));
    execSync("git init", { cwd: otherRepo, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', {
      cwd: otherRepo,
      stdio: "ignore",
    });
    execSync('git config user.name "Test"', {
      cwd: otherRepo,
      stdio: "ignore",
    });
    writeFileSync(join(otherRepo, "README.md"), "# Other Repo\n");
    execSync("git add .", { cwd: otherRepo, stdio: "ignore" });
    execSync('git commit -m "initial"', { cwd: otherRepo, stdio: "ignore" });

    let worktreeCwd: string | undefined;

    const provider = makeTestProvider(async (_args, opts) => {
      worktreeCwd = opts.cwd;
      return { exitCode: 0 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "test",
      cwd: otherRepo,
    });

    expect(result.exitCode).toBe(0);
    // The worktree should be under the other repo's .sandcastle/worktrees/ dir
    expect(worktreeCwd).toBeDefined();
    expect(worktreeCwd!.startsWith(otherRepo)).toBe(true);
  });

  it("without cwd behaves identically to process.cwd()", async () => {
    let worktreeCwd: string | undefined;

    const provider = makeTestProvider(async (_args, opts) => {
      worktreeCwd = opts.cwd;
      return { exitCode: 0 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "test",
      // no cwd option
    });

    expect(result.exitCode).toBe(0);
    // The worktree should be under process.cwd() (which is hostDir)
    expect(worktreeCwd).toBeDefined();
    expect(worktreeCwd!.startsWith(hostDir)).toBe(true);
  });

  it("copies files to worktree with copyToWorktree", async () => {
    // Create a file to copy
    const nodeModulesDir = join(hostDir, "node_modules");
    execSync(`mkdir -p ${nodeModulesDir}`);
    writeFileSync(join(nodeModulesDir, "test-dep.txt"), "dependency");

    let copiedFileExists = false;

    const provider = makeTestProvider(async (_args, opts) => {
      const cwd = opts.cwd!;
      copiedFileExists = existsSync(join(cwd, "node_modules", "test-dep.txt"));
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: provider,
      prompt: "test",
      branchStrategy: { type: "merge-to-head" },
      copyToWorktree: ["node_modules"],
    });

    expect(copiedFileExists).toBe(true);
  });
});
