import { describe, expect, it, vi } from "vitest";

// Simulate a Windows host: route the bare `join` export to `path.win32.join`,
// while leaving `posix` untouched. The fix must use `posix.join` for any path
// destined for the (Linux) sandbox container, so it survives this mock.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    default: actual,
    join: actual.win32.join,
  };
});

import { Effect } from "effect";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";
import { sandboxSessionStore } from "./SessionStore.js";
import { SessionPaths, defaultSessionPathsLayer } from "./SessionPaths.js";

describe("sandboxSessionStore on Windows-style hosts", () => {
  it("uses POSIX separators for in-container paths regardless of host platform", async () => {
    const copyOutCalls: Array<{ from: string; to: string }> = [];
    const copyInCalls: Array<{ from: string; to: string }> = [];
    const execCalls: string[] = [];

    const handle: Pick<
      BindMountSandboxHandle,
      "copyFileIn" | "copyFileOut" | "exec"
    > = {
      copyFileIn: async (from, to) => {
        copyInCalls.push({ from, to });
      },
      copyFileOut: async (from, to) => {
        copyOutCalls.push({ from, to });
        const fs = await import("node:fs/promises");
        await fs.writeFile(to, "");
      },
      exec: async (cmd) => {
        execCalls.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const store = sandboxSessionStore(
      "/home/agent/workspace",
      handle as BindMountSandboxHandle,
      "/home/agent/.claude/projects",
    );

    expect(store.sessionFilePath("abc")).not.toMatch(/\\/);

    await store.readSession("abc");
    expect(copyOutCalls).toHaveLength(1);
    expect(copyOutCalls[0]!.from).not.toMatch(/\\/);
    expect(copyOutCalls[0]!.from).toBe(
      "/home/agent/.claude/projects/-home-agent-workspace/abc.jsonl",
    );

    await store.writeSession("xyz", "{}");
    expect(copyInCalls).toHaveLength(1);
    expect(copyInCalls[0]!.to).not.toMatch(/\\/);
    expect(copyInCalls[0]!.to).toBe(
      "/home/agent/.claude/projects/-home-agent-workspace/xyz.jsonl",
    );
    expect(execCalls[0]).not.toMatch(/\\/);
    expect(execCalls[0]).toContain(
      "/home/agent/.claude/projects/-home-agent-workspace",
    );
  });

  it("defaultSessionPathsLayer produces a POSIX sandboxProjectsDir", async () => {
    const paths = await Effect.runPromise(
      Effect.provide(SessionPaths, defaultSessionPathsLayer),
    );
    expect(paths.sandboxProjectsDir).not.toMatch(/\\/);
    expect(paths.sandboxProjectsDir).toBe("/home/agent/.claude/projects");
  });
});
