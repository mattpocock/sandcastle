import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BindMountSandboxHandle,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import {
  claudeCode,
  claudeHostSessionPath,
  createBindMountSandboxProvider,
  encodeProjectPath,
  run,
} from "@ai-hero/sandcastle";

// Claude Code names its session directory after the physical path of its
// working directory. A repo reached through a symlink (macOS's /tmp ->
// /private/tmp, for instance) used to fail every run with SessionCaptureError
// (#1305): Sandcastle looked for the session under the path as given.

const SESSION_ID = "sess-symlink";

/** A junction on Windows needs no Developer Mode; a dir symlink elsewhere. */
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

/** Writes one line of Claude Code's session JSONL at the agent's project dir. */
const writeAgentSession = async (
  sandboxProjectsDir: string,
  worktreePath: string,
): Promise<void> => {
  const physical = await realpath(worktreePath);
  const sessionPath = path.posix.join(
    sandboxProjectsDir,
    encodeProjectPath(physical),
    `${SESSION_ID}.jsonl`,
  );
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({ type: "system", cwd: physical })}\n`,
  );
};

/**
 * A sandbox sharing the host filesystem, as `noSandbox()` and `seatbelt()`
 * do, whose agent behaves like Claude Code: it writes its session under the
 * physical path of its working directory.
 */
const hostFilesystemSandbox = (sandboxProjectsDir: string): SandboxProvider =>
  createBindMountSandboxProvider({
    name: "host-fs",
    create: async ({ worktreePath }): Promise<BindMountSandboxHandle> => ({
      worktreePath,
      exec: async (_command, options) => {
        if (options?.onLine !== undefined) {
          await writeAgentSession(sandboxProjectsDir, worktreePath);
          options.onLine(
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: SESSION_ID,
            }),
          );
          options.onLine(JSON.stringify({ type: "result", result: "done" }));
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      copyFileIn: async (hostPath, sandboxPath) => {
        await copyFile(hostPath, sandboxPath);
      },
      copyFileOut: async (sandboxPath, hostPath) => {
        await copyFile(sandboxPath, hostPath);
      },
      close: async () => undefined,
    }),
  });

describe("Claude session capture from a repo reached through a symlink", () => {
  let root = "";
  let realRepo = "";
  let linkedRepo = "";

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), "sandcastle-symlink-")),
    );
    realRepo = path.join(root, "real-repo");
    linkedRepo = path.join(root, "linked-repo");
    await mkdir(realRepo);
    git(realRepo, "init", "-b", "main");
    git(realRepo, "config", "user.email", "test@test.com");
    git(realRepo, "config", "user.name", "Test");
    git(realRepo, "commit", "--allow-empty", "-m", "init");
    await symlink(realRepo, linkedRepo, LINK_TYPE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("captures the session the agent wrote under the physical path", async () => {
    const hostProjectsDir = path.join(root, "host-projects");
    const sandboxProjectsDir = path.join(root, "sandbox-projects");

    const result = await run({
      agent: claudeCode("claude-opus-4-8", {
        sessionStorage: { hostProjectsDir, sandboxProjectsDir },
      }),
      sandbox: hostFilesystemSandbox(sandboxProjectsDir),
      cwd: linkedRepo,
      prompt: "Do the thing.",
      branchStrategy: { type: "head" },
      logging: { type: "file", path: path.join(root, "run.log") },
    });

    expect(result.iterations[0]?.sessionFilePath).toBe(
      claudeHostSessionPath(realRepo, SESSION_ID, hostProjectsDir),
    );
  });
});
