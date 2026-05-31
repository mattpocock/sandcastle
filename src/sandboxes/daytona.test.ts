import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- Hoisted mock factories ----------
// vi.hoisted ensures these are available when vi.mock factory functions run,
// since vi.mock calls are hoisted above imports by Vitest.

const { mockSandbox, mockClient, MockDaytona } = vi.hoisted(() => {
  const mockSandbox = {
    getWorkDir: vi.fn(),
    getUserHomeDir: vi.fn(),
    process: {
      createSession: vi.fn(),
      executeSessionCommand: vi.fn(),
      getSessionCommandLogs: vi.fn(),
      getSessionCommand: vi.fn(),
      deleteSession: vi.fn(),
      executeCommand: vi.fn(),
    },
    fs: {
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
    },
  };

  const mockClient = {
    create: vi.fn(),
    delete: vi.fn(),
  };

  const MockDaytona = vi.fn();

  return { mockSandbox, mockClient, MockDaytona };
});

const { mockStat, mockReaddir } = vi.hoisted(() => ({
  mockStat: vi.fn(),
  mockReaddir: vi.fn(),
}));

// ---------- Module mocks ----------

vi.mock("@daytona/sdk", () => ({ Daytona: MockDaytona }));

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return { ...actual, stat: mockStat, readdir: mockReaddir };
});

// ---------- Subject under test ----------

import { daytona } from "./daytona.js";

// ---------- Default mock setup ----------

beforeEach(() => {
  MockDaytona.mockReturnValue(mockClient);
  mockClient.create.mockResolvedValue(mockSandbox);
  mockClient.delete.mockResolvedValue(undefined);
  mockSandbox.getWorkDir.mockResolvedValue("/home/daytona/workspace");
  mockSandbox.getUserHomeDir.mockResolvedValue("/home/daytona");
  mockSandbox.process.createSession.mockResolvedValue(undefined);
  mockSandbox.process.executeSessionCommand.mockResolvedValue({
    cmdId: "cmd-123",
  });
  mockSandbox.process.getSessionCommandLogs.mockResolvedValue(undefined);
  mockSandbox.process.getSessionCommand.mockResolvedValue({ exitCode: 0 });
  mockSandbox.process.deleteSession.mockResolvedValue(undefined);
  mockSandbox.process.executeCommand.mockResolvedValue({
    result: "hello",
    exitCode: 0,
  });
  mockSandbox.fs.uploadFile.mockResolvedValue(undefined);
  mockSandbox.fs.downloadFile.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
});

// ---------- Tests ----------

describe("daytona()", () => {
  it("returns a SandboxProvider with tag 'isolated' and name 'daytona'", () => {
    const provider = daytona();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("daytona");
  });

  it("has a create function", () => {
    const provider = daytona();
    expect(typeof provider.create).toBe("function");
  });

  it("accepts an apiKey option without throwing", () => {
    const provider = daytona({ apiKey: "dyt_my_key" });
    expect(provider.tag).toBe("isolated");
  });

  it("accepts an env option", () => {
    const provider = daytona({ env: { MY_VAR: "hello" } });
    expect(provider.env).toEqual({ MY_VAR: "hello" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = daytona();
    expect(provider.env).toEqual({});
  });

  it("accepts maxOutputTailChars option without throwing", () => {
    const provider = daytona({ maxOutputTailChars: 1024 });
    expect(provider.tag).toBe("isolated");
  });

  it("constructs Daytona client with empty config when no options given", async () => {
    const provider = daytona();
    await provider.create({ env: {} });
    expect(MockDaytona).toHaveBeenCalledWith({});
  });

  it("passes apiKey to Daytona constructor when provided", async () => {
    const provider = daytona({ apiKey: "dyt_my_key" });
    await provider.create({ env: {} });
    expect(MockDaytona).toHaveBeenCalledWith({ apiKey: "dyt_my_key" });
  });

  it("passes apiUrl and target to Daytona constructor when provided", async () => {
    const provider = daytona({
      apiUrl: "https://api.daytona.io",
      target: "us-east",
    });
    await provider.create({ env: {} });
    expect(MockDaytona).toHaveBeenCalledWith({
      apiUrl: "https://api.daytona.io",
      target: "us-east",
    });
  });

  it("uses getWorkDir() as worktreePath when it returns a value", async () => {
    const provider = daytona();
    const handle = await provider.create({ env: {} });
    expect(handle.worktreePath).toBe("/home/daytona/workspace");
  });

  it("falls back to getUserHomeDir() when getWorkDir() returns null", async () => {
    mockSandbox.getWorkDir.mockResolvedValue(null);
    const provider = daytona();
    const handle = await provider.create({ env: {} });
    expect(handle.worktreePath).toBe("/home/daytona");
  });

  it("falls back to '/home/daytona' when both getWorkDir() and getUserHomeDir() return null", async () => {
    mockSandbox.getWorkDir.mockResolvedValue(null);
    mockSandbox.getUserHomeDir.mockResolvedValue(null);
    const provider = daytona();
    const handle = await provider.create({ env: {} });
    expect(handle.worktreePath).toBe("/home/daytona");
  });

  describe("handle.exec() without onLine", () => {
    it("calls executeCommand and returns stdout/stderr/exitCode", async () => {
      mockSandbox.process.executeCommand.mockResolvedValue({
        result: "hello world",
        exitCode: 0,
      });
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      const result = await handle.exec("echo hello");
      expect(mockSandbox.process.executeCommand).toHaveBeenCalledWith(
        "echo hello",
        "/home/daytona/workspace",
      );
      expect(result).toEqual({
        stdout: "hello world",
        stderr: "",
        exitCode: 0,
      });
    });

    it("uses custom cwd when provided", async () => {
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.exec("ls", { cwd: "/tmp" });
      expect(mockSandbox.process.executeCommand).toHaveBeenCalledWith(
        "ls",
        "/tmp",
      );
    });

    it("prepends 'sudo ' to the command when sudo is true", async () => {
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.exec("apt-get install vim", { sudo: true });
      expect(mockSandbox.process.executeCommand).toHaveBeenCalledWith(
        "sudo apt-get install vim",
        expect.any(String),
      );
    });

    it("returns non-zero exitCode from executeCommand", async () => {
      mockSandbox.process.executeCommand.mockResolvedValue({
        result: "",
        exitCode: 127,
      });
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      const result = await handle.exec("nonexistent-cmd");
      expect(result.exitCode).toBe(127);
    });
  });

  describe("handle.exec() with onLine streaming", () => {
    it("creates a session, executes async, streams lines, then deletes session", async () => {
      mockSandbox.process.getSessionCommandLogs.mockImplementation(
        async (
          _sid: string,
          _cid: string,
          stdoutCb: (chunk: string) => void,
        ) => {
          stdoutCb("line1\nline2\n");
        },
      );

      const lines: string[] = [];
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.exec("echo output", { onLine: (l) => lines.push(l) });

      expect(mockSandbox.process.createSession).toHaveBeenCalledOnce();
      expect(mockSandbox.process.executeSessionCommand).toHaveBeenCalledOnce();
      expect(mockSandbox.process.deleteSession).toHaveBeenCalledOnce();
      expect(lines).toEqual(["line1", "line2"]);
    });

    it("passes async: true in executeSessionCommand", async () => {
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.exec("echo hello", { onLine: () => {} });

      const call = mockSandbox.process.executeSessionCommand.mock
        .calls[0] as unknown[];
      const opts = call[1] as { command: string; async: boolean };
      expect(opts.async).toBe(true);
    });

    it("includes cd <cwd> prefix in executeSessionCommand command", async () => {
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.exec("ls", { onLine: () => {}, cwd: "/tmp" });

      const call = mockSandbox.process.executeSessionCommand.mock
        .calls[0] as unknown[];
      const opts = call[1] as { command: string; async: boolean };
      expect(opts.command).toContain("cd /tmp");
    });

    it("calls onLine for a partial line without trailing newline", async () => {
      mockSandbox.process.getSessionCommandLogs.mockImplementation(
        async (
          _sid: string,
          _cid: string,
          stdoutCb: (chunk: string) => void,
        ) => {
          stdoutCb("no newline at end");
        },
      );

      const lines: string[] = [];
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.exec("printf 'no newline'", {
        onLine: (l) => lines.push(l),
      });

      expect(lines).toContain("no newline at end");
    });

    it("returns the exit code from getSessionCommand", async () => {
      mockSandbox.process.getSessionCommand.mockResolvedValue({ exitCode: 42 });
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      const result = await handle.exec("exit 42", { onLine: () => {} });
      expect(result.exitCode).toBe(42);
    });

    it("defaults exitCode to 0 when getSessionCommand returns null exitCode", async () => {
      mockSandbox.process.getSessionCommand.mockResolvedValue({
        exitCode: null,
      });
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      const result = await handle.exec("cmd", { onLine: () => {} });
      expect(result.exitCode).toBe(0);
    });

    it("deletes session even when streaming throws an error", async () => {
      mockSandbox.process.getSessionCommandLogs.mockRejectedValue(
        new Error("stream failed"),
      );
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await expect(
        handle.exec("echo hello", { onLine: () => {} }),
      ).rejects.toThrow("stream failed");
      expect(mockSandbox.process.deleteSession).toHaveBeenCalledOnce();
    });

    it("includes stdout output in the returned ExecResult", async () => {
      mockSandbox.process.getSessionCommandLogs.mockImplementation(
        async (
          _sid: string,
          _cid: string,
          stdoutCb: (chunk: string) => void,
        ) => {
          stdoutCb("result line\n");
        },
      );

      const provider = daytona();
      const handle = await provider.create({ env: {} });
      const result = await handle.exec("cmd", { onLine: () => {} });
      expect(result.stdout).toContain("result line");
    });
  });

  describe("handle.copyIn()", () => {
    it("uploads a single file directly when hostPath is a file", async () => {
      mockStat.mockResolvedValue({ isDirectory: () => false });

      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.copyIn("/host/file.txt", "/sandbox/file.txt");

      expect(mockSandbox.fs.uploadFile).toHaveBeenCalledWith(
        "/host/file.txt",
        "/sandbox/file.txt",
      );
    });

    it("recursively walks and uploads all files in a directory", async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockReaddir
        .mockResolvedValueOnce([
          { name: "a.txt", isDirectory: () => false },
          { name: "sub", isDirectory: () => true },
        ])
        .mockResolvedValueOnce([{ name: "b.txt", isDirectory: () => false }]);

      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.copyIn("/host/dir", "/sandbox/dir");

      expect(mockSandbox.fs.uploadFile).toHaveBeenCalledTimes(2);
    });

    it("preserves relative path structure when uploading directory contents", async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockReaddir.mockResolvedValueOnce([
        { name: "readme.txt", isDirectory: () => false },
      ]);

      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.copyIn("/host/project", "/sandbox/project");

      expect(mockSandbox.fs.uploadFile).toHaveBeenCalledWith(
        expect.stringContaining("readme.txt"),
        expect.stringContaining("readme.txt"),
      );
    });
  });

  describe("handle.copyFileOut()", () => {
    it("calls sandbox.fs.downloadFile with correct arguments", async () => {
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.copyFileOut("/sandbox/output.txt", "/host/output.txt");

      expect(mockSandbox.fs.downloadFile).toHaveBeenCalledWith(
        "/sandbox/output.txt",
        "/host/output.txt",
      );
    });
  });

  describe("handle.close()", () => {
    it("calls client.delete(sandbox) to destroy the sandbox", async () => {
      const provider = daytona();
      const handle = await provider.create({ env: {} });
      await handle.close();

      expect(mockClient.delete).toHaveBeenCalledWith(mockSandbox);
    });

    it("propagates errors from client.delete()", async () => {
      mockClient.delete.mockRejectedValue(new Error("delete failed"));

      const provider = daytona();
      const handle = await provider.create({ env: {} });

      await expect(handle.close()).rejects.toThrow("delete failed");
    });
  });
});
