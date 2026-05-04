import { describe, expect, it } from "vitest";
import {
  type SessionStore,
  encodeProjectPath,
  hostSessionStore,
  sandboxSessionStore,
  transferSession,
} from "./SessionStore.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory SessionStore for testing transferSession without filesystem. */
const createMemoryStore = (
  cwd: string,
  initial?: Record<string, string>,
): SessionStore & { data: Map<string, string> } => {
  const data = new Map<string, string>(initial ? Object.entries(initial) : []);
  return {
    cwd,
    data,
    sessionFilePath: (id: string): string => `${cwd}/sessions/${id}.jsonl`,
    readSession: async (id: string): Promise<string> => {
      const content = data.get(id);
      if (content === undefined)
        throw new Error(`session ${id} not found in memory store`);
      return content;
    },
    writeSession: async (id: string, content: string): Promise<void> => {
      data.set(id, content);
    },
  };
};

// ---------------------------------------------------------------------------
// encodeProjectPath
// ---------------------------------------------------------------------------

describe("encodeProjectPath", () => {
  it("encodes absolute path by replacing path separators with hyphens", () => {
    expect(encodeProjectPath("/home/user/repos/my-project")).toBe(
      "-home-user-repos-my-project",
    );
  });

  it("encodes root path", () => {
    expect(encodeProjectPath("/")).toBe("-");
  });

  it("encodes path without leading slash", () => {
    expect(encodeProjectPath("home/user")).toBe("home-user");
  });

  it("strips trailing slash before encoding", () => {
    expect(encodeProjectPath("/home/user/")).toBe("-home-user");
  });

  // Windows-style paths
  it("encodes Windows path with backslashes and drive letter", () => {
    expect(encodeProjectPath("D:\\projektit\\super-app")).toBe(
      "D-projektit-super-app",
    );
  });

  it("strips trailing backslash before encoding", () => {
    expect(encodeProjectPath("C:\\Users\\rootti\\repos\\foo\\")).toBe(
      "C-Users-rootti-repos-foo",
    );
  });

  it("encodes Windows drive root", () => {
    expect(encodeProjectPath("C:\\")).toBe("C-");
  });

  it("encodes drive letter without trailing separator", () => {
    expect(encodeProjectPath("C:")).toBe("C");
  });

  it("strips multiple trailing backslashes", () => {
    expect(encodeProjectPath("D:\\projekts\\app\\\\")).toBe("D-projekts-app");
  });
});

// ---------------------------------------------------------------------------
// transferSession — cwd rewriting
// ---------------------------------------------------------------------------

describe("transferSession", () => {
  it("rewrites cwd fields in JSONL entries from source cwd to target cwd", async () => {
    const jsonl = [
      JSON.stringify({ type: "system", cwd: "/sandbox/worktree" }),
      JSON.stringify({ type: "message", content: "hello" }),
      JSON.stringify({
        type: "tool_call",
        cwd: "/sandbox/worktree",
        name: "Read",
      }),
    ].join("\n");

    const source = createMemoryStore("/sandbox/worktree", { sess123: jsonl });
    const target = createMemoryStore("/home/user/repos/project");

    await transferSession(source, target, "sess123");

    const written = target.data.get("sess123")!;
    const lines = written.split("\n");

    expect(JSON.parse(lines[0]!)).toEqual({
      type: "system",
      cwd: "/home/user/repos/project",
    });
    // Line without cwd should be unchanged
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "message",
      content: "hello",
    });
    expect(JSON.parse(lines[2]!)).toEqual({
      type: "tool_call",
      cwd: "/home/user/repos/project",
      name: "Read",
    });
  });

  it("preserves session ID key through transfer", async () => {
    const jsonl = JSON.stringify({ type: "init", cwd: "/a" });
    const source = createMemoryStore("/a", { "my-session-id": jsonl });
    const target = createMemoryStore("/b");

    await transferSession(source, target, "my-session-id");

    expect(target.data.has("my-session-id")).toBe(true);
    expect(target.data.has("sess123")).toBe(false);
  });

  it("round-trips bytes through transfer for entries without cwd", async () => {
    const jsonl = [
      JSON.stringify({ type: "message", content: "hello world" }),
      JSON.stringify({
        type: "tool_result",
        output: "result with special chars: \t\n",
      }),
    ].join("\n");

    const source = createMemoryStore("/src", { s1: jsonl });
    const target = createMemoryStore("/dst");

    await transferSession(source, target, "s1");

    expect(target.data.get("s1")).toBe(jsonl);
  });

  it("handles empty JSONL", async () => {
    const source = createMemoryStore("/a", { s1: "" });
    const target = createMemoryStore("/b");

    await transferSession(source, target, "s1");

    expect(target.data.get("s1")).toBe("");
  });

  it("only rewrites cwd fields that match source cwd exactly", async () => {
    const jsonl = [
      JSON.stringify({ type: "a", cwd: "/sandbox/worktree" }),
      JSON.stringify({ type: "b", cwd: "/other/path" }),
    ].join("\n");

    const source = createMemoryStore("/sandbox/worktree", { s1: jsonl });
    const target = createMemoryStore("/host/repo");

    await transferSession(source, target, "s1");

    const lines = target.data.get("s1")!.split("\n");
    expect(JSON.parse(lines[0]!).cwd).toBe("/host/repo");
    // Non-matching cwd should remain unchanged
    expect(JSON.parse(lines[1]!).cwd).toBe("/other/path");
  });

  it("throws when session ID does not exist in source", async () => {
    const source = createMemoryStore("/a");
    const target = createMemoryStore("/b");

    await expect(transferSession(source, target, "missing")).rejects.toThrow(
      "session missing not found",
    );
  });
});

// ---------------------------------------------------------------------------
// hostSessionStore — path encoding and filesystem
// ---------------------------------------------------------------------------

describe("hostSessionStore", () => {
  let tempDir: string;

  const setup = async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sandcastle-session-test-"));
    return tempDir;
  };

  const teardown = async () => {
    await rm(tempDir, { recursive: true, force: true });
  };

  it("writes session to encoded project path", async () => {
    const dir = await setup();
    try {
      const store = hostSessionStore("/home/user/project", dir);
      await store.writeSession(
        "sess-1",
        JSON.stringify({ type: "init", cwd: "/home/user/project" }),
      );

      const encoded = encodeProjectPath("/home/user/project");
      const filePath = join(dir, encoded, "sess-1.jsonl");
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("init");
    } finally {
      await teardown();
    }
  });

  it("reads back a written session", async () => {
    const dir = await setup();
    try {
      const store = hostSessionStore("/my/repo", dir);
      const jsonl = JSON.stringify({ type: "system", cwd: "/my/repo" });

      await store.writeSession("s1", jsonl);
      const result = await store.readSession("s1");

      expect(result).toBe(jsonl);
    } finally {
      await teardown();
    }
  });

  it("reads Pi-style timestamp-prefixed session files by ID", async () => {
    const dir = await setup();
    try {
      const store = hostSessionStore("/my/repo", dir);
      const encoded = encodeProjectPath("/my/repo");
      const projectDir = join(dir, encoded);
      const jsonl = JSON.stringify({ type: "session", id: "s1" });
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "2026-01-01T00-00-00_s1.jsonl"), jsonl);

      const result = await store.readSession("s1");

      expect(result).toBe(jsonl);
    } finally {
      await teardown();
    }
  });

  it("throws on read of non-existent session", async () => {
    const dir = await setup();
    try {
      const store = hostSessionStore("/my/repo", dir);
      await expect(store.readSession("nope")).rejects.toThrow();
    } finally {
      await teardown();
    }
  });

  it("uses cwd as the store cwd", async () => {
    const dir = await setup();
    try {
      const store = hostSessionStore("/my/repo", dir);
      expect(store.cwd).toBe("/my/repo");
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// sandboxSessionStore — uses bind-mount handle
// ---------------------------------------------------------------------------

describe("sandboxSessionStore", () => {
  it("uses copyFileOut for readSession", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sandcastle-sbx-store-"));
    try {
      const jsonl = JSON.stringify({ type: "init", cwd: "/workspace" });

      // Write a file to the "sandbox" location to simulate copyFileOut reading it
      const sandboxCwd = "/workspace";
      const encoded = encodeProjectPath(sandboxCwd);
      const sandboxProjectDir = join(tempDir, ".claude", "projects", encoded);
      await mkdir(sandboxProjectDir, { recursive: true });
      await writeFile(join(sandboxProjectDir, "s1.jsonl"), jsonl);

      const copyFileOutCalls: Array<{ from: string; to: string }> = [];

      const handle: Pick<
        BindMountSandboxHandle,
        "copyFileIn" | "copyFileOut" | "exec"
      > = {
        copyFileIn: async () => {},
        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          copyFileOutCalls.push({ from: sandboxPath, to: hostPath });
          // Simulate actual copy for the read to work
          const content = await readFile(sandboxPath, "utf-8");
          await mkdir(join(hostPath, ".."), { recursive: true });
          await writeFile(hostPath, content);
        },
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      };

      const store = sandboxSessionStore(
        sandboxCwd,
        handle as BindMountSandboxHandle,
        join(tempDir, ".claude", "projects"),
      );

      const result = await store.readSession("s1");

      expect(copyFileOutCalls.length).toBe(1);
      expect(copyFileOutCalls[0]!.from).toContain("s1.jsonl");
      expect(result).toBe(jsonl);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads Pi-style timestamp-prefixed sandbox session files by ID", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sandcastle-sbx-store-"));
    try {
      const jsonl = JSON.stringify({ type: "session", id: "s1" });
      const sandboxCwd = "/workspace";
      const encoded = encodeProjectPath(sandboxCwd);
      const sandboxProjectDir = join(tempDir, ".claude", "projects", encoded);
      const sandboxSessionPath = join(
        sandboxProjectDir,
        "2026-01-01T00-00-00_s1.jsonl",
      );
      await mkdir(sandboxProjectDir, { recursive: true });
      await writeFile(sandboxSessionPath, jsonl);

      const handle: Pick<
        BindMountSandboxHandle,
        "copyFileIn" | "copyFileOut" | "exec"
      > = {
        copyFileIn: async () => {},
        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          const content = await readFile(sandboxPath, "utf-8");
          await mkdir(join(hostPath, ".."), { recursive: true });
          await writeFile(hostPath, content);
        },
        exec: async () => ({
          stdout: `${sandboxSessionPath}\n`,
          stderr: "",
          exitCode: 0,
        }),
      };

      const store = sandboxSessionStore(
        sandboxCwd,
        handle as BindMountSandboxHandle,
        join(tempDir, ".claude", "projects"),
      );

      const result = await store.readSession("s1");

      expect(result).toBe(jsonl);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses copyFileIn for writeSession", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sandcastle-sbx-store-"));
    try {
      const jsonl = JSON.stringify({ type: "init" });

      const copyFileInCalls: Array<{ from: string; to: string }> = [];

      const handle: Pick<
        BindMountSandboxHandle,
        "copyFileIn" | "copyFileOut" | "exec"
      > = {
        copyFileIn: async (hostPath: string, sandboxPath: string) => {
          copyFileInCalls.push({ from: hostPath, to: sandboxPath });
        },
        copyFileOut: async () => {},
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      };

      const sandboxCwd = "/workspace";
      const store = sandboxSessionStore(
        sandboxCwd,
        handle as BindMountSandboxHandle,
        join(tempDir, ".claude", "projects"),
      );

      await store.writeSession("s2", jsonl);

      expect(copyFileInCalls.length).toBe(1);
      expect(copyFileInCalls[0]!.to).toContain("s2.jsonl");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stages host-side temp files outside the sandbox projectsDir", async () => {
    // projectsDir is a sandbox-only path that does not exist on the host.
    // copyFileOut receives (sandboxPath, hostTmpPath); the hostTmpPath must be
    // writable on the host — i.e. not under the sandbox-only projectsDir.
    const sandboxOnlyProjectsDir = "/nonexistent-on-host/.claude/projects";
    const sessionContent = JSON.stringify({ type: "init" });

    const handle: Pick<
      BindMountSandboxHandle,
      "copyFileIn" | "copyFileOut" | "exec"
    > = {
      copyFileIn: async (hostPath: string) => {
        // Must be able to read from the host tmp path.
        await readFile(hostPath, "utf-8");
      },
      copyFileOut: async (_sandboxPath: string, hostPath: string) => {
        // Must be able to write to the host tmp path.
        await writeFile(hostPath, sessionContent);
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };

    const store = sandboxSessionStore(
      "/workspace",
      handle as BindMountSandboxHandle,
      sandboxOnlyProjectsDir,
    );

    await expect(store.readSession("s1")).resolves.toBe(sessionContent);
    await expect(store.writeSession("s2", "x")).resolves.toBeUndefined();
  });

  it("mkdirs the sandbox project directory before copyFileIn on writeSession", async () => {
    // Regression: docker/podman `cp` require the destination's parent directory
    // to exist. Fresh sandboxes don't have ~/.claude/projects/<encoded>/ yet,
    // so writeSession must create it before copying the file in.
    const calls: string[] = [];

    const handle: Pick<
      BindMountSandboxHandle,
      "copyFileIn" | "copyFileOut" | "exec"
    > = {
      copyFileIn: async () => {
        calls.push("copyFileIn");
      },
      copyFileOut: async () => {},
      exec: async (command: string) => {
        calls.push(`exec:${command}`);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const store = sandboxSessionStore(
      "/home/agent/workspace",
      handle as BindMountSandboxHandle,
      "/home/agent/.claude/projects",
    );

    await store.writeSession("s1", "{}");

    expect(calls.length).toBe(2);
    expect(calls[0]).toMatch(/^exec:mkdir -p /);
    expect(calls[0]).toContain(
      "/home/agent/.claude/projects/-home-agent-workspace",
    );
    expect(calls[1]).toBe("copyFileIn");
  });

  it("exposes cwd", () => {
    const handle = {
      copyFileIn: async () => {},
      copyFileOut: async () => {},
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as BindMountSandboxHandle;

    const store = sandboxSessionStore(
      "/sandbox/work",
      handle,
      "/tmp/.claude/projects",
    );
    expect(store.cwd).toBe("/sandbox/work");
  });
});
