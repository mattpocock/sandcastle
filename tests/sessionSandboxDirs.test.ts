import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentProvider,
  BindMountSandboxHandle,
} from "@ai-hero/sandcastle";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
} from "@ai-hero/sandcastle";

// Session capture and resume run commands and copies inside the sandbox. A
// native sandbox can't mount a fixed `/home/agent` or `/tmp` (seatbelt()
// can't remap paths at all), so every agent must take the sandbox's home and
// temp dir from the handle, and fall back to `/home/agent` and `/tmp` (the
// Docker image layout) only when the handle doesn't say.

const SESSION_ID = "sess-dirs";
const SANDBOX_CWD = "/work/repo";
const HOME = "/sbx/private-home";
const TEMP = "/sbx/private-temp";

interface Recorded {
  readonly commands: string[];
  /** Sandbox-side paths given to copyFileIn / copyFileOut. */
  readonly sandboxPaths: string[];
}

/**
 * A sandbox that records what core asks of it. `find` answers with one file
 * matching its `-name` glob under the dir it was asked to search, the way a
 * real sandbox holding that session would; copies out write a session line.
 */
const recordingHandle = (
  dirs: { sandboxHomedir?: string; sandboxTmpdir?: string },
  recorded: Recorded,
): BindMountSandboxHandle => ({
  worktreePath: SANDBOX_CWD,
  ...dirs,
  exec: async (command) => {
    recorded.commands.push(command);
    const find = /^find "(?<dir>[^"]+)" -type f -name "(?<glob>[^"]+)"/u.exec(
      command,
    );
    if (find?.groups !== undefined) {
      const { dir = "", glob = "" } = find.groups;
      const file = glob.replaceAll("*", "x");
      return { stdout: `${dir}/2026/${file}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  copyFileIn: async (_hostPath, sandboxPath) => {
    recorded.sandboxPaths.push(sandboxPath);
  },
  copyFileOut: async (sandboxPath, hostPath) => {
    recorded.sandboxPaths.push(sandboxPath);
    writeFileSync(
      hostPath,
      `${JSON.stringify({ type: "user", cwd: SANDBOX_CWD })}\n`,
    );
  },
  close: async () => undefined,
});

const agents = (hostDir: string) => ({
  claudeCode: claudeCode("m", {
    sessionStorage: { hostProjectsDir: path.join(hostDir, "claude") },
  }),
  codex: codex("m", {
    sessionStorage: { hostSessionsDir: path.join(hostDir, "codex") },
  }),
  pi: pi("m", {
    sessionStorage: { hostSessionsDir: path.join(hostDir, "pi") },
  }),
  cursor: cursor("m", {
    sessionStorage: { hostChatsDir: path.join(hostDir, "cursor") },
  }),
  opencode: opencode("m", {
    sessionStorage: { hostSessionsDir: path.join(hostDir, "opencode") },
  }),
  copilot: copilot("m", {
    sessionStorage: { hostSessionsDir: path.join(hostDir, "copilot") },
  }),
});

/** Capture a session out of the sandbox, then resume it back in. */
const roundTrip = async (
  agent: AgentProvider,
  handle: BindMountSandboxHandle,
  hostCwd: string,
): Promise<void> => {
  const storage = agent.sessionStorage;
  if (storage === undefined) {
    throw new Error(`${agent.name} has no session storage`);
  }
  const transfer = {
    hostCwd,
    sandboxCwd: SANDBOX_CWD,
    sessionId: SESSION_ID,
    handle,
  };
  await storage.captureToHost(transfer);
  await storage.resumeIntoSandbox(transfer);
};

describe("session capture and resume inside a sandbox", () => {
  let hostDir = "";

  beforeEach(() => {
    hostDir = mkdtempSync(path.join(tmpdir(), "session-dirs-"));
  });

  afterEach(() => {
    rmSync(hostDir, { recursive: true, force: true });
  });

  const agentNames = [
    "claudeCode",
    "codex",
    "pi",
    "cursor",
    "opencode",
    "copilot",
  ] as const;

  it.each(agentNames)(
    "%s uses the home and temp dir the sandbox reports, never /home/agent or /tmp",
    async (name) => {
      const recorded: Recorded = { commands: [], sandboxPaths: [] };
      const handle = recordingHandle(
        { sandboxHomedir: HOME, sandboxTmpdir: TEMP },
        recorded,
      );

      await roundTrip(
        agents(hostDir)[name],
        handle,
        path.join(hostDir, "repo"),
      );

      const used = [...recorded.commands, ...recorded.sandboxPaths];
      expect(used.length).toBeGreaterThan(0);
      for (const entry of used) {
        expect(entry).not.toMatch(/\/home\/agent|(?:^|[^\w-])\/tmp\b/u);
      }
      // Each sandbox path lives in the reported home or temp dir, or the repo.
      for (const sandboxPath of recorded.sandboxPaths) {
        expect(
          [HOME, TEMP, SANDBOX_CWD].some((dir) =>
            sandboxPath.startsWith(`${dir}/`),
          ),
        ).toBe(true);
      }
    },
  );

  it("claudeCode lists subagent transcripts under the reported home", async () => {
    const recorded: Recorded = { commands: [], sandboxPaths: [] };
    const handle = recordingHandle({ sandboxHomedir: HOME }, recorded);

    await roundTrip(
      agents(hostDir).claudeCode,
      handle,
      path.join(hostDir, "repo"),
    );

    const listing = recorded.commands.find((c) => c.startsWith("find "));
    expect(listing).toContain(
      `"${HOME}/.claude/projects/-work-repo/${SESSION_ID}/subagents"`,
    );
    expect(recorded.sandboxPaths).toContain(
      `${HOME}/.claude/projects/-work-repo/${SESSION_ID}/subagents/2026/agent-x.jsonl`,
    );
  });

  it("opencode exports into the reported temp dir", async () => {
    const recorded: Recorded = { commands: [], sandboxPaths: [] };
    const handle = recordingHandle({ sandboxTmpdir: TEMP }, recorded);

    await roundTrip(
      agents(hostDir).opencode,
      handle,
      path.join(hostDir, "repo"),
    );

    expect(recorded.commands).toContain(
      `opencode export '${SESSION_ID}' > '${TEMP}/${SESSION_ID}.json'`,
    );
    expect(recorded.sandboxPaths).toContain(`${TEMP}/${SESSION_ID}.json`);
  });

  it("falls back to /home/agent and /tmp when the sandbox doesn't say (Docker, Podman)", async () => {
    const recorded: Recorded = { commands: [], sandboxPaths: [] };
    const handle = recordingHandle({}, recorded);
    const all = agents(hostDir);

    await roundTrip(all.claudeCode, handle, path.join(hostDir, "repo"));
    await roundTrip(all.opencode, handle, path.join(hostDir, "repo"));

    expect(recorded.sandboxPaths).toContain(
      `/home/agent/.claude/projects/-work-repo/${SESSION_ID}.jsonl`,
    );
    expect(recorded.commands).toContain(
      `opencode export '${SESSION_ID}' > '/tmp/${SESSION_ID}.json'`,
    );
  });

  it("keeps an explicit sessionStorage sandbox dir over the reported home", async () => {
    const recorded: Recorded = { commands: [], sandboxPaths: [] };
    const handle = recordingHandle({ sandboxHomedir: HOME }, recorded);
    const agent = claudeCode("m", {
      sessionStorage: {
        hostProjectsDir: path.join(hostDir, "claude"),
        sandboxProjectsDir: "/custom/projects",
      },
    });

    await roundTrip(agent, handle, path.join(hostDir, "repo"));

    expect(recorded.sandboxPaths).toContain(
      `/custom/projects/-work-repo/${SESSION_ID}.jsonl`,
    );
  });
});
