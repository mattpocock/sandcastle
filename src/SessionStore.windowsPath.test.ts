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

import { claudeSandboxSessionPath } from "./SessionStore.js";

describe("claudeSandboxSessionPath on Windows-style hosts", () => {
  it("uses POSIX separators for in-container paths regardless of host platform", () => {
    const path = claudeSandboxSessionPath(
      "/home/agent/workspace",
      "abc",
      "/home/agent/.claude/projects",
    );

    expect(path).not.toMatch(/\\/u);
    expect(path).toBe(
      "/home/agent/.claude/projects/-home-agent-workspace/abc.jsonl",
    );
  });
});
