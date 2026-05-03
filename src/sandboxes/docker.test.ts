import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );

  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

import { execFile, spawn } from "node:child_process";
import { docker } from "./docker.js";
import type { BindMountSandboxHandle } from "../SandboxProvider.js";

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);

afterEach(() => {
  mockExecFile.mockReset();
  mockSpawn.mockReset();
});

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

  it("resolves relative hostPath against process.cwd()", () => {
    // "src" directory exists relative to cwd (the repo root)
    const provider = docker({
      mounts: [{ hostPath: "src", sandboxPath: "/mnt/src" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("resolves dot-prefixed relative hostPath against process.cwd()", () => {
    const provider = docker({
      mounts: [{ hostPath: "./src", sandboxPath: "/mnt/src" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("throws for relative hostPath that does not exist", () => {
    expect(() =>
      docker({
        mounts: [{ hostPath: "nonexistent_dir_xyz", sandboxPath: "/mnt/data" }],
      }),
    ).toThrow("Mount hostPath does not exist");
  });

  it("resolves relative sandboxPath against sandbox repo dir", () => {
    const provider = docker({
      mounts: [{ hostPath: "src", sandboxPath: "data" }],
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

  it("accepts a network option as a string", () => {
    const provider = docker({ network: "my-network" });
    expect(provider.tag).toBe("bind-mount");
  });

  it("accepts a network option as an array", () => {
    const provider = docker({ network: ["net1", "net2"] });
    expect(provider.tag).toBe("bind-mount");
  });

  it("passes context to docker lifecycle commands", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      queueMicrotask(() => proc.emit("close", 0));
      return proc;
    });

    const provider = docker({ context: "colima" });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["--context", "colima", "ps"]),
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["--context", "colima", "run"]),
      expect.any(Object),
      expect.any(Function),
    );

    await handle.exec("echo hello");

    expect(mockSpawn).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["--context", "colima", "exec"]),
      expect.any(Object),
    );

    const bmHandle = handle as BindMountSandboxHandle;
    await bmHandle.copyFileIn("/host/file.txt", "/sandbox/file.txt");
    await bmHandle.copyFileOut("/sandbox/output.txt", "/host/output.txt");

    const cpCalls = mockExecFile.mock.calls.filter(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args.includes("--context") &&
        args.includes("colima") &&
        args.includes("cp"),
    );
    expect(cpCalls).toHaveLength(2);

    await handle.close();

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["--context", "colima", "stop"]),
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["--context", "colima", "rm"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("copyFileIn calls docker cp with correct arguments", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = docker();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const bmHandle = handle as BindMountSandboxHandle;
    await bmHandle.copyFileIn("/host/file.txt", "/sandbox/file.txt");

    const cpCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args[0] === "cp" &&
        args[1] === "/host/file.txt",
    );
    expect(cpCall).toBeDefined();
    const cpArgs = cpCall![1] as string[];
    expect(cpArgs[0]).toBe("cp");
    expect(cpArgs[1]).toBe("/host/file.txt");
    expect(cpArgs[2]).toMatch(/^sandcastle-.*:\/sandbox\/file\.txt$/);

    await handle.close();
  });

  it("copyFileOut calls docker cp with correct arguments", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = docker();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const bmHandle = handle as BindMountSandboxHandle;
    await bmHandle.copyFileOut("/sandbox/output.txt", "/host/output.txt");

    const cpCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args[0] === "cp" &&
        args[2] === "/host/output.txt",
    );
    expect(cpCall).toBeDefined();
    const cpArgs = cpCall![1] as string[];
    expect(cpArgs[0]).toBe("cp");
    expect(cpArgs[1]).toMatch(/^sandcastle-.*:\/sandbox\/output\.txt$/);
    expect(cpArgs[2]).toBe("/host/output.txt");

    await handle.close();
  });

  it("copyFileIn rejects when docker cp fails", async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "cp") {
        callback(new Error("no such file"));
      } else {
        callback(null, "", "");
      }
      return undefined as any;
    });

    const provider = docker();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const bmHandle = handle as BindMountSandboxHandle;
    await expect(
      bmHandle.copyFileIn("/nonexistent", "/sandbox/file.txt"),
    ).rejects.toThrow("docker cp (in) failed");

    await handle.close();
  });
});
