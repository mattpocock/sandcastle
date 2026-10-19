import { afterEach, describe, expect, it, vi } from "vitest";
import { setVercelSandboxCreate } from "../test-fixtures/vercel-sandbox.js";
import { vercel } from "./vercel.js";

type RunCommand = (options: { cmd: string }) => Promise<{
  exitCode: number;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
}>;

type WriteFiles = (
  files: Array<{ path: string; content: string | Buffer }>,
) => Promise<void>;

const configureVercelSandbox = (
  runCommand: RunCommand,
  writeFiles: WriteFiles = vi.fn(async () => {}),
): void => {
  setVercelSandboxCreate(async () => ({
    runCommand,
    writeFiles,
    readFileToBuffer: vi.fn(),
    stop: vi.fn(async () => {}),
  }));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vercel()", () => {
  it("returns a SandboxProvider with tag 'isolated' and name 'vercel'", () => {
    const provider = vercel();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("vercel");
  });

  it("has a create function", () => {
    const provider = vercel();
    expect(typeof provider.create).toBe("function");
  });

  it.each([
    ["2.9", "/vercel/sandbox", "/vercel/sandbox/workspace"],
    ["3.2", "/vercel", "/vercel/workspace"],
  ])(
    "discovers the worktree path for Vercel SDK %s",
    async (_version, defaultCwd, expectedWorktreePath) => {
      const runCommand = vi.fn(async (options: { cmd: string }) => ({
        exitCode: 0,
        stdout: async () => (options.cmd === "pwd" ? `${defaultCwd}\n` : ""),
        stderr: async () => "",
      }));
      configureVercelSandbox(runCommand);

      const handle = await vercel().create({ env: {} });

      expect(handle.worktreePath).toBe(expectedWorktreePath);
      expect(runCommand).toHaveBeenNthCalledWith(1, { cmd: "pwd" });
      expect(runCommand).toHaveBeenNthCalledWith(2, {
        cmd: "mkdir",
        args: ["-p", expectedWorktreePath],
      });
    },
  );

  it("accepts a token option", () => {
    // Should not throw
    const provider = vercel({ token: "my-token" });
    expect(provider.tag).toBe("isolated");
  });

  it("passes through Vercel SDK options", () => {
    // Should not throw when arbitrary SDK options are provided
    const provider = vercel({
      template: "node-22",
      timeoutMs: 30_000,
    });
    expect(provider.tag).toBe("isolated");
  });

  it("accepts an env option", () => {
    const provider = vercel({ env: { VERCEL_VAR: "value" } });
    expect(provider.tag).toBe("isolated");
    expect(provider.env).toEqual({ VERCEL_VAR: "value" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = vercel();
    expect(provider.env).toEqual({});
  });

  it("delivers exec stdin through a temporary sandbox file", async () => {
    const runCommand = vi.fn(async (options: { cmd: string }) => ({
      exitCode: 0,
      stdout: async () =>
        options.cmd === "pwd"
          ? "/vercel/sandbox\n"
          : options.cmd === "sh"
            ? "agent output"
            : "",
      stderr: async () => "",
    }));
    const writeFiles = vi.fn(
      async (
        _files: Array<{ path: string; content: string | Buffer }>,
      ): Promise<void> => {},
    );
    configureVercelSandbox(runCommand, writeFiles);

    const handle = await vercel().create({ env: {} });
    const result = await handle.exec("claude --print -p -", {
      stdin: "prompt with 'quotes'\nand a trailing newline\n",
    });

    const { path, content } = writeFiles.mock.calls[0]![0]![0]!;
    expect(path).toMatch(/^\/tmp\/sandcastle-stdin-[\da-f-]+$/);
    expect(content.toString()).toBe(
      "prompt with 'quotes'\nand a trailing newline\n",
    );
    expect(runCommand).toHaveBeenNthCalledWith(3, {
      cmd: "sh",
      args: [
        "-c",
        `chmod 600 '${path}' && sh -c 'claude --print -p -' < '${path}'`,
      ],
      cwd: "/vercel/sandbox/workspace",
    });
    expect(runCommand).toHaveBeenNthCalledWith(4, {
      cmd: "rm",
      args: ["-f", "--", path],
    });
    expect(result).toEqual({
      stdout: "agent output",
      stderr: "",
      exitCode: 0,
    });
  });

  it("delivers stdin while streaming output and cleans up after failure", async () => {
    const executionError = new Error("remote command failed");
    const runCommand = vi.fn(async (options: { cmd: string }) => {
      if (options.cmd === "sh") throw executionError;
      return {
        exitCode: 0,
        stdout: async () => (options.cmd === "pwd" ? "/vercel/sandbox\n" : ""),
        stderr: async () => "",
      };
    });
    const writeFiles = vi.fn(
      async (
        _files: Array<{ path: string; content: string | Buffer }>,
      ): Promise<void> => {},
    );
    configureVercelSandbox(runCommand, writeFiles);

    const handle = await vercel().create({ env: {} });
    await expect(
      handle.exec("claude --model 'claude-opus' --print -p -", {
        stdin: "prompt",
        onLine: vi.fn(),
      }),
    ).rejects.toBe(executionError);

    const stdinPath = writeFiles.mock.calls[0]![0]![0]!.path;
    expect(runCommand).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        cmd: "sh",
        args: [
          "-c",
          `chmod 600 '${stdinPath}' && sh -c 'claude --model '\\''claude-opus'\\'' --print -p -' < '${stdinPath}'`,
        ],
      }),
    );
    expect(runCommand).toHaveBeenNthCalledWith(4, {
      cmd: "rm",
      args: ["-f", "--", stdinPath],
    });
  });
});
