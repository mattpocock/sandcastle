import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { docker } from "./docker.js";
import { execFile, spawn } from "node:child_process";

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFile.mockImplementation((_cmd, args, _opts, callback) => {
    const subcommand = Array.isArray(args) ? args[0] : undefined;
    if (subcommand === "ps") {
      (callback as Function)(null, "", "");
      return {} as any;
    }
    (callback as Function)(null, "ok", "");
    return {} as any;
  });
});

const mockDockerSpawnSuccess = (
  stdout: string,
  stderr = "",
  onInput?: (input: string) => void,
) => {
  mockSpawn.mockImplementation((_cmd, _args, _opts) => {
    const proc = new EventEmitter() as any;
    const stdin = new PassThrough();
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    let input = "";

    stdin.on("data", (chunk: Buffer) => {
      input += chunk.toString();
    });

    stdin.on("end", () => {
      onInput?.(input);
      stdoutStream.end(stdout);
      stderrStream.end(stderr);
      proc.emit("close", 0);
    });

    proc.stdin = stdin;
    proc.stdout = stdoutStream;
    proc.stderr = stderrStream;

    return proc;
  });
};

describe("docker()", () => {
  it("returns a SandboxProvider with tag 'bind-mount' and name 'docker'", () => {
    const provider = docker();
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("docker");
  });

  it("accepts an imageName option", () => {
    const provider = docker({ imageName: "my-image:latest" });
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("docker");
  });

  it("has a create function", () => {
    const provider = docker();
    expect(typeof provider.create).toBe("function");
  });

  it("does not have a branchStrategy property", () => {
    const provider = docker();
    expect("branchStrategy" in provider).toBe(false);
  });

  it("accepts a mounts option with valid paths", () => {
    const provider = docker({
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("throws at construction time if a mount hostPath does not exist", () => {
    expect(() =>
      docker({
        mounts: [
          {
            hostPath: "/nonexistent/path/does/not/exist",
            sandboxPath: "/mnt/cache",
          },
        ],
      }),
    ).toThrow("Mount hostPath does not exist");
  });

  it("expands tilde in mount hostPath at construction time", () => {
    // This succeeds because ~ resolves to the home directory which exists
    const provider = docker({
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home", readonly: true }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("accepts an env option", () => {
    const provider = docker({ env: { MY_VAR: "hello" } });
    expect(provider.tag).toBe("bind-mount");
    expect(provider.env).toEqual({ MY_VAR: "hello" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = docker();
    expect(provider.env).toEqual({});
  });

  it("exec sends commands to sh via stdin instead of argv", async () => {
    let seenInput = "";
    mockDockerSpawnSuccess("ok", "", (input) => {
      seenInput = input;
    });

    const provider = docker();
    if (provider.tag !== "bind-mount") throw new Error("unreachable");

    const handle = await provider.create({
      worktreePath: "/host/worktree",
      hostRepoPath: "/host/repo",
      mounts: [
        {
          hostPath: "/host/worktree",
          sandboxPath: "/sandbox/workspace",
        },
      ],
      env: {},
    });

    const result = await handle.exec("printf ok", { cwd: "/repo" });

    expect(result.stdout).toBe("ok");
    expect(seenInput).toBe("printf ok");
    expect(mockSpawn).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["exec", "-i", "-w", "/repo", "sh"]),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("-c");
    expect(args).not.toContain("printf ok");
  });

  it("exec streams lines while still sending stdin", async () => {
    let seenInput = "";
    mockDockerSpawnSuccess("line 1\nline 2\n", "", (input) => {
      seenInput = input;
    });

    const provider = docker();
    if (provider.tag !== "bind-mount") throw new Error("unreachable");

    const handle = await provider.create({
      worktreePath: "/host/worktree",
      hostRepoPath: "/host/repo",
      mounts: [
        {
          hostPath: "/host/worktree",
          sandboxPath: "/sandbox/workspace",
        },
      ],
      env: {},
    });

    const lines: string[] = [];
    const result = await handle.exec("printf 'line 1\\nline 2\\n'", {
      cwd: "/repo",
      onLine: (line) => lines.push(line),
    });

    expect(result.stdout).toBe("line 1\nline 2\n");
    expect(lines).toEqual(["line 1", "line 2"]);
    expect(seenInput).toBe("printf 'line 1\\nline 2\\n'");
    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("-c");
  });
});
