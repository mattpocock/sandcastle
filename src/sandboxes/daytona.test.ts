import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@daytona/sdk", () => ({
  Daytona: class {
    create = sdk.create;
    delete = sdk.delete;
  },
}));

import { daytona } from "./daytona.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("daytona()", () => {
  it("delivers exec stdin through a temporary sandbox file", async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        result: "agent output",
        exitCode: 0,
      })
      .mockResolvedValueOnce({ result: "", exitCode: 0 });
    const uploadFile = vi.fn(
      async (_content: Buffer, _path: string): Promise<void> => {},
    );
    sdk.create.mockResolvedValue({
      getWorkDir: vi.fn(async () => "/home/daytona/workspace"),
      getUserHomeDir: vi.fn(async () => "/home/daytona"),
      process: { executeCommand },
      fs: { uploadFile },
    });

    const handle = await daytona().create({ env: {} });
    const result = await handle.exec("claude --print -p -", {
      stdin: "prompt with 'quotes'\nand a trailing newline\n",
    });

    const [content, path] = uploadFile.mock.calls[0]!;
    expect(path).toMatch(/^\/tmp\/sandcastle-stdin-[\da-f-]+$/);
    expect(content.toString()).toBe(
      "prompt with 'quotes'\nand a trailing newline\n",
    );
    expect(executeCommand).toHaveBeenNthCalledWith(
      1,
      `chmod 600 '${path}' && sh -c 'claude --print -p -' < '${path}'`,
      "/home/daytona/workspace",
    );
    expect(executeCommand).toHaveBeenNthCalledWith(2, `rm -f -- '${path}'`);
    expect(result).toEqual({
      stdout: "agent output",
      stderr: "",
      exitCode: 0,
    });
  });

  it("delivers stdin while streaming output and cleans up after failure", async () => {
    const executionError = new Error("remote command failed");
    const executeSessionCommand = vi.fn().mockRejectedValue(executionError);
    const deleteSession = vi.fn(async () => {});
    const executeCommand = vi.fn(async () => ({ result: "", exitCode: 0 }));
    const uploadFile = vi.fn(
      async (_content: Buffer, _path: string): Promise<void> => {},
    );
    sdk.create.mockResolvedValue({
      getWorkDir: vi.fn(async () => "/home/daytona/workspace"),
      getUserHomeDir: vi.fn(async () => "/home/daytona"),
      process: {
        createSession: vi.fn(async () => {}),
        executeSessionCommand,
        deleteSession,
        executeCommand,
      },
      fs: { uploadFile },
    });

    const handle = await daytona().create({ env: {} });
    await expect(
      handle.exec("claude --model 'claude-opus' --print -p -", {
        stdin: "prompt",
        onLine: vi.fn(),
      }),
    ).rejects.toBe(executionError);

    const stdinPath = uploadFile.mock.calls[0]![1];
    expect(executeSessionCommand).toHaveBeenCalledWith(expect.any(String), {
      command: `cd /home/daytona/workspace && chmod 600 '${stdinPath}' && sh -c 'claude --model '\\''claude-opus'\\'' --print -p -' < '${stdinPath}'`,
      async: true,
    });
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(executeCommand).toHaveBeenCalledWith(`rm -f -- '${stdinPath}'`);
  });

  it("cleans up stdin when the requested working directory is invalid", async () => {
    const uploadedFiles = new Set<string>();
    const invalidCwd = "/missing/worktree";
    const executeCommand = vi.fn(async (command: string, cwd?: string) => {
      if (cwd === invalidCwd) {
        return { result: "", exitCode: 1 };
      }

      const removedPath = command.match(/^rm -f -- '([^']+)'$/)?.[1];
      if (removedPath) uploadedFiles.delete(removedPath);
      return { result: "", exitCode: 0 };
    });
    const uploadFile = vi.fn(async (_content: Buffer, path: string) => {
      uploadedFiles.add(path);
    });
    sdk.create.mockResolvedValue({
      getWorkDir: vi.fn(async () => "/home/daytona/workspace"),
      getUserHomeDir: vi.fn(async () => "/home/daytona"),
      process: { executeCommand },
      fs: { uploadFile },
    });

    const handle = await daytona().create({ env: {} });
    const result = await handle.exec("agent --prompt -", {
      cwd: invalidCwd,
      stdin: "prompt",
    });

    expect(result.exitCode).toBe(1);
    expect(uploadedFiles).toEqual(new Set());
  });
});
