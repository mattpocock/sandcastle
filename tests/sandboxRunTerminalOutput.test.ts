import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BindMountSandboxHandle,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import {
  claudeCode,
  createBindMountSandboxProvider,
  createSandbox,
} from "@ai-hero/sandcastle";

// sandbox.run({ logging: { type: "stdout" } }) on a createSandbox() sandbox
// shows the agent's text and tool calls in the terminal, the same as run()
// does (#966). Before, a reusable sandbox picked a silent display for every
// logging type but "file", so the terminal showed nothing.

const text = "streamed agent text";

const lines = [
  { type: "system", subtype: "init", session_id: "sess" },
  { type: "assistant", message: { content: [{ type: "text", text }] } },
  {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Bash", input: { command: "npm test" } },
      ],
    },
  },
  { type: "result", subtype: "success", result: text },
].map((event) => JSON.stringify(event));

/** A sandbox whose Claude Code streams one text message and one Bash call. */
const scripted: SandboxProvider = createBindMountSandboxProvider({
  name: "scripted",
  create: async (options): Promise<BindMountSandboxHandle> => ({
    worktreePath: options.worktreePath,
    exec: async (command, execOptions) => {
      if (!command.startsWith("claude ")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      for (const line of lines) {
        execOptions?.onLine?.(line);
      }
      return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
    },
    copyFileIn: async () => undefined,
    copyFileOut: async (_sandboxPath, hostPath) => {
      mkdirSync(path.dirname(hostPath), { recursive: true });
      writeFileSync(hostPath, "");
    },
    close: async () => undefined,
  }),
});

describe("sandbox.run() with stdout logging", () => {
  let repo = "";

  beforeEach(() => {
    repo = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "e2e-sandbox-terminal-")),
    );
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# repo\n");
    git("add", ".");
    git("commit", "-m", "init");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(repo, { recursive: true, force: true });
  });

  it("prints the agent's text and tool calls to the terminal", async () => {
    const written: string[] = [];
    const sandbox = await createSandbox({
      branch: "terminal",
      cwd: repo,
      sandbox: scripted,
    });
    try {
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });
      await sandbox.run({
        agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
        prompt: "do something",
        logging: { type: "stdout" },
      });
    } finally {
      vi.restoreAllMocks();
      await sandbox.close();
    }

    const terminal = written.join("");
    expect(terminal).toContain(text);
    expect(terminal).toContain("npm test");
  }, 30_000);
});
