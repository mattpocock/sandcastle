import { exec, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { assert, describe, expect, it } from "vitest";
import { claudeCode } from "./AgentProvider.js";
import { createSandbox } from "./createSandbox.js";
import { createWorktree } from "./createWorktree.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import type { ExecResult } from "./SandboxProvider.js";

const execAsync = promisify(exec);

/**
 * Regression tests for agent-factory env (`claudeCode(m, { env })`) under the
 * long-lived sandbox entry points. The container is created before any agent
 * is chosen, so the env must reach the agent process of each `sb.run()`.
 */

const setupRepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-env-"));
  const hostDir = join(root, "repo");
  const binDir = join(root, "bin");
  await mkdir(hostDir);
  await mkdir(binDir);
  await execAsync("git init -b main", { cwd: hostDir });
  await execAsync('git config user.email "test@test.com"', { cwd: hostDir });
  await execAsync('git config user.name "Test"', { cwd: hostDir });
  await writeFile(join(hostDir, "init.txt"), "init");
  await execAsync("git add init.txt && git commit -m init", { cwd: hostDir });

  // A fake `claude` binary that reports the marker env var it was started with.
  const fakeClaude = join(binDir, "claude");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      `printf '{"type":"result","result":"mark=%s"}\\n' "$VERIFY_AGENT_MARK"`,
      "",
    ].join("\n"),
  );
  await chmod(fakeClaude, 0o755);
  const gitConfig = join(root, ".gitconfig");
  await writeFile(gitConfig, "");
  return { root, hostDir, binDir, gitConfig };
};

/**
 * A bind-mount provider that behaves like a container: every exec runs
 * `sh -c` with only the env the sandbox was created with (plus PATH).
 */
const shellProvider = (
  binDir: string,
  gitConfig: string,
  providerEnv?: Record<string, string>,
) =>
  createBindMountSandboxProvider({
    name: "shell",
    env: providerEnv,
    create: async (opts) => ({
      worktreePath: opts.worktreePath,
      exec: async (command, execOpts): Promise<ExecResult> =>
        new Promise((resolve, reject) => {
          const proc = spawn("sh", ["-c", command], {
            cwd: execOpts?.cwd ?? opts.worktreePath,
            env: {
              ...opts.env,
              PATH: `${binDir}:${process.env.PATH}`,
              HOME: process.env.HOME,
              GIT_CONFIG_GLOBAL: gitConfig,
            },
            stdio: [
              execOpts?.stdin === undefined ? "ignore" : "pipe",
              "pipe",
              "pipe",
            ],
          });
          if (execOpts?.stdin !== undefined) {
            assert(proc.stdin, "stdin is piped");
            proc.stdin.end(execOpts.stdin);
          }
          let stdout = "";
          let stderr = "";
          assert(proc.stdout && proc.stderr, "stdout and stderr are piped");
          createInterface({ input: proc.stdout }).on("line", (line) => {
            stdout += `${line}\n`;
            execOpts?.onLine?.(line);
          });
          proc.stderr.on("data", (c: Buffer) => {
            stderr += c.toString();
          });
          proc.on("error", reject);
          proc.on("close", (code) => {
            resolve({ stdout, stderr, exitCode: code ?? 0 });
          });
        }),
      copyFileIn: async () => {},
      copyFileOut: async () => {},
      close: async () => {},
    }),
  });

const MARK = "agent env with 'quotes' $HOME";

describe("agent-factory env under long-lived sandboxes", () => {
  it("createSandbox().run() passes the agent's env to the agent process", async () => {
    const { root, hostDir, binDir, gitConfig } = await setupRepo();
    const sb = await createSandbox({
      branch: "agent-env-sb",
      sandbox: shellProvider(binDir, gitConfig),
      cwd: hostDir,
    });
    try {
      const result = await sb.run({
        agent: claudeCode("test-model", { env: { VERIFY_AGENT_MARK: MARK } }),
        prompt: "go",
        logging: { type: "file", path: join(root, "run.log") },
      });
      expect(result.stdout).toContain(`mark=${MARK}`);

      // A later run with a different agent gets only that agent's env.
      const second = await sb.run({
        agent: claudeCode("test-model"),
        prompt: "go",
        logging: { type: "file", path: join(root, "run2.log") },
      });
      expect(second.stdout).toContain("mark=");
      expect(second.stdout).not.toContain(MARK);
    } finally {
      await sb.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("createWorktree().createSandbox().run() passes the agent's env to the agent process", async () => {
    const { root, hostDir, binDir, gitConfig } = await setupRepo();
    const wt = await createWorktree({
      branchStrategy: { type: "branch", branch: "agent-env-wtsb" },
      cwd: hostDir,
    });
    try {
      const sb = await wt.createSandbox({
        sandbox: shellProvider(binDir, gitConfig),
      });
      try {
        const result = await sb.run({
          agent: claudeCode("test-model", {
            env: { VERIFY_AGENT_MARK: MARK },
          }),
          prompt: "go",
          logging: { type: "file", path: join(root, "run.log") },
        });
        expect(result.stdout).toContain(`mark=${MARK}`);
      } finally {
        await sb.close();
      }
    } finally {
      await wt.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("createSandbox().run() rejects agent env keys that overlap the sandbox provider's env, like run()", async () => {
    const { root, hostDir, binDir, gitConfig } = await setupRepo();
    const sb = await createSandbox({
      branch: "agent-env-overlap",
      sandbox: shellProvider(binDir, gitConfig, { VERIFY_AGENT_MARK: "x" }),
      cwd: hostDir,
    });
    try {
      await expect(
        sb.run({
          agent: claudeCode("test-model", {
            env: { VERIFY_AGENT_MARK: "y" },
          }),
          prompt: "go",
          logging: { type: "file", path: join(root, "run.log") },
        }),
      ).rejects.toThrow(/Overlapping env keys/u);
    } finally {
      await sb.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
