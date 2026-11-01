import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentProvider,
  BindMountSandboxHandle,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import {
  claudeCode,
  codex,
  createBindMountSandboxProvider,
  pi,
  run,
} from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

// run({ resumeSession }) checks the session exists on the host before it
// starts the agent. Without a sandbox the agent wrote the session in place, so
// it is found by id anywhere under the agent's store; with a sandbox it must sit
// at the store location for the host repo, where Sandcastle's capture puts it.
//
// The agents here are real providers whose command is swapped for a harmless
// `echo`, so a run that passes the check finishes without a real agent CLI.

const SESSION_ID = "9ba1c695-2222-4444-8888-e7e847bf34dd";

const harmless = <A extends AgentProvider>(provider: A): A => ({
  ...provider,
  buildPrintCommand: () => ({ command: "echo done" }),
});

/** Plays back Claude Code's stream-json for one turn of session `sess-1`. */
const scriptedSandbox = (): SandboxProvider => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
    JSON.stringify({ type: "result", subtype: "success", result: "done" }),
  ];
  return createBindMountSandboxProvider({
    name: "scripted",
    create: async (options): Promise<BindMountSandboxHandle> => ({
      worktreePath: options.worktreePath,
      exec: async (_command, execOptions) => {
        for (const line of lines) {
          execOptions?.onLine?.(line);
        }
        return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
      },
      copyFileIn: async () => undefined,
      copyFileOut: async () => undefined,
      close: async () => undefined,
    }),
  });
};

describe("run({ resumeSession }) checks the session before starting", () => {
  let repo = "";
  let store = "";

  const resume = async (
    agent: AgentProvider,
    sandbox: SandboxProvider,
    resumeSession: string,
  ) =>
    run({
      agent,
      sandbox,
      cwd: repo,
      prompt: "Carry on.",
      resumeSession,
      branchStrategy: { type: "head" },
      logging: { type: "file", path: path.join(repo, "run.log") },
    });

  /** Writes an empty session file at `file`, creating its directory. */
  const writeSession = (file: string): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{}\n");
  };

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "e2e-resume-"));
    store = mkdtempSync(path.join(tmpdir(), "e2e-resume-store-"));
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
    rmSync(store, { recursive: true, force: true });
  });

  describe("without a sandbox", () => {
    it("finds a Claude Code session under a project dir that doesn't match the repo", async () => {
      // The agent wrote it from a worktree, so the dir encodes a path the
      // host repo's encoding would never produce.
      writeSession(
        path.join(
          store,
          "-private-tmp-myrepo--sandcastle-worktrees-feature",
          `${SESSION_ID}.jsonl`,
        ),
      );
      const agent = harmless(
        claudeCode("claude-opus-4-8", {
          captureSessions: false,
          sessionStorage: { hostProjectsDir: store },
        }),
      );

      const result = await resume(agent, noSandbox(), SESSION_ID);

      expect(result.iterations).toHaveLength(1);
    });

    it("rejects a missing Claude Code session, naming the store it searched", async () => {
      const agent = harmless(
        claudeCode("claude-opus-4-8", {
          captureSessions: false,
          sessionStorage: { hostProjectsDir: store },
        }),
      );

      await expect(resume(agent, noSandbox(), "missing-id")).rejects.toThrow(
        `resumeSession "missing-id" not found under ${store}`,
      );
    });

    it("finds a Pi session under any encoded-cwd dir", async () => {
      writeSession(
        path.join(
          store,
          "--some-encoded-cwd--",
          `2026-05-29T08-00-00_${SESSION_ID}.jsonl`,
        ),
      );
      const agent = harmless(
        pi("claude-sonnet-4-6", {
          captureSessions: false,
          sessionStorage: { hostSessionsDir: store },
        }),
      );

      const result = await resume(agent, noSandbox(), SESSION_ID);

      expect(result.iterations).toHaveLength(1);
    });

    it("rejects a missing Pi session, naming the store it searched", async () => {
      const agent = harmless(
        pi("claude-sonnet-4-6", {
          captureSessions: false,
          sessionStorage: { hostSessionsDir: store },
        }),
      );

      await expect(resume(agent, noSandbox(), "missing-id")).rejects.toThrow(
        `resumeSession "missing-id" not found under ${store}`,
      );
    });

    it("finds a Codex rollout under the date-nested sessions dir", async () => {
      writeSession(
        path.join(
          store,
          "2026",
          "05",
          "26",
          `rollout-2026-05-26T08-00-00-${SESSION_ID}.jsonl`,
        ),
      );
      const agent = harmless(
        codex("gpt-5.4-mini", {
          captureSessions: false,
          sessionStorage: { hostSessionsDir: store },
        }),
      );

      const result = await resume(agent, noSandbox(), SESSION_ID);

      expect(result.iterations).toHaveLength(1);
    });
  });

  describe("in a sandbox", () => {
    it("finds a Claude Code session at the host repo's store location", async () => {
      const agent = claudeCode("claude-opus-4-8", {
        captureSessions: false,
        sessionStorage: { hostProjectsDir: store },
      });
      const sessionFile = agent.sessionStorage.hostSessionFilePath(
        repo,
        SESSION_ID,
      );
      assert.isDefined(sessionFile);
      writeSession(sessionFile);

      const result = await resume(agent, scriptedSandbox(), SESSION_ID);

      expect(result.iterations).toHaveLength(1);
    });

    it("rejects a missing Claude Code session, naming the file it expected", async () => {
      const agent = claudeCode("claude-opus-4-8", {
        captureSessions: false,
        sessionStorage: { hostProjectsDir: store },
      });

      await expect(resume(agent, scriptedSandbox(), "abc-123")).rejects.toThrow(
        'resumeSession "abc-123" not found: expected session file at',
      );
    });

    it("finds a Pi session in the host repo's session dir", async () => {
      const agent = harmless(
        pi("claude-sonnet-4-6", {
          captureSessions: false,
          sessionStorage: { hostSessionsDir: store },
        }),
      );
      const sessionDir = agent.sessionStorage.hostSessionFilePath(
        repo,
        SESSION_ID,
      );
      assert.isDefined(sessionDir);
      writeSession(
        path.join(sessionDir, `2026-05-29T08-00-00_${SESSION_ID}.jsonl`),
      );

      const result = await resume(agent, scriptedSandbox(), SESSION_ID);

      expect(result.iterations).toHaveLength(1);
    });

    it("rejects a missing Pi session, naming the dir it expected", async () => {
      const agent = pi("claude-sonnet-4-6", {
        captureSessions: false,
        sessionStorage: { hostSessionsDir: store },
      });

      await expect(resume(agent, scriptedSandbox(), "abc-123")).rejects.toThrow(
        'resumeSession "abc-123" not found: expected session file at',
      );
    });
  });

  it("rejects resumeSession for an agent with no session storage", async () => {
    const { sessionStorage: _none, ...agent } = harmless(
      claudeCode("claude-opus-4-8", { captureSessions: false }),
    );

    await expect(
      resume({ ...agent, name: "stub-agent" }, noSandbox(), SESSION_ID),
    ).rejects.toThrow("stub-agent does not support resumeSession");
  });
});

describe("RunResult.fork()", () => {
  let repo = "";
  let store = "";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "e2e-fork-"));
    store = mkdtempSync(path.join(tmpdir(), "e2e-fork-store-"));
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
    rmSync(store, { recursive: true, force: true });
  });

  const firstRun = async (agent: AgentProvider) =>
    run({
      agent,
      sandbox: scriptedSandbox(),
      cwd: repo,
      prompt: "Start.",
      branchStrategy: { type: "head" },
      logging: { type: "file", path: path.join(repo, "run.log") },
    });

  it("rejects with ForkNotSupportedError naming an agent that can't fork", async () => {
    const claude = claudeCode("claude-opus-4-8", {
      captureSessions: false,
      sessionStorage: { hostProjectsDir: store },
    });
    const agent: AgentProvider = {
      ...claude,
      name: "stub-agent",
      sessionStorage: { ...claude.sessionStorage, canFork: false },
    };
    const result = await firstRun(agent);
    assert.isDefined(result.fork);

    const failure: unknown = await result
      .fork("Branch off.")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      _tag: "ForkNotSupportedError",
      name: "ForkNotSupportedError",
      agentProvider: "stub-agent",
    });
    expect(String(failure)).toContain("stub-agent cannot fork");
  });

  it("forks for an agent that can (canFork omitted)", async () => {
    const agent = claudeCode("claude-opus-4-8", {
      captureSessions: false,
      sessionStorage: { hostProjectsDir: store },
    });
    const result = await firstRun(agent);
    assert.isDefined(result.fork);
    const sessionFile = agent.sessionStorage.hostSessionFilePath(
      repo,
      "sess-1",
    );
    assert.isDefined(sessionFile);
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, "{}\n");

    const forked = await result.fork("Branch off.");

    expect(forked.iterations).toHaveLength(1);
  });
});
