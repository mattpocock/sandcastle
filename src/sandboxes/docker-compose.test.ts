import { afterEach, describe, expect, it, vi } from "vitest";

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

import { execFile } from "node:child_process";
import { dockerCompose } from "./docker-compose.js";
import type { BindMountSandboxHandle } from "../SandboxProvider.js";

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
});

const okExecFile = () => {
  mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
    const callback = rest[rest.length - 1];
    callback(null, "", "");
    return undefined as any;
  });
};

const findRunArgs = (): string[] | undefined => {
  const call = mockExecFile.mock.calls.find(
    ([, args]) =>
      Array.isArray(args) && args[0] === "compose" && args.includes("run"),
  );
  return call ? (call[1] as string[]) : undefined;
};

describe("dockerCompose()", () => {
  it("returns a SandboxProvider with tag 'bind-mount' and name 'docker-compose'", () => {
    const provider = dockerCompose();
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("docker-compose");
  });

  it("has a create function", () => {
    const provider = dockerCompose();
    expect(typeof provider.create).toBe("function");
  });

  it("does not have a branchStrategy property", () => {
    const provider = dockerCompose();
    expect("branchStrategy" in provider).toBe(false);
  });

  it("accepts a mounts option with valid paths", () => {
    const provider = dockerCompose({
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("throws at construction time if a mount hostPath does not exist", () => {
    expect(() =>
      dockerCompose({
        mounts: [
          {
            hostPath: "/nonexistent/path/does/not/exist",
            sandboxPath: "/mnt/cache",
          },
        ],
      }),
    ).toThrow("Mount hostPath does not exist");
  });

  it("throws at construction time if composeFile does not exist", () => {
    expect(() =>
      dockerCompose({
        composeFile: "/nonexistent/docker-compose.yml",
      }),
    ).toThrow("Compose file does not exist");
  });

  it("accepts an env option", () => {
    const provider = dockerCompose({ env: { MY_VAR: "hello" } });
    expect(provider.env).toEqual({ MY_VAR: "hello" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = dockerCompose();
    expect(provider.env).toEqual({});
  });

  it("does not run UID pre-flight (no docker image inspect call)", async () => {
    okExecFile();

    const provider = dockerCompose();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const inspectCall = mockExecFile.mock.calls.find(
      ([, args]) =>
        Array.isArray(args) && args[0] === "image" && args[1] === "inspect",
    );
    expect(inspectCall).toBeUndefined();

    await handle.close();
  });

  it("invokes 'docker compose run -d --name <name> agent' by default", async () => {
    okExecFile();

    const provider = dockerCompose();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const args = findRunArgs();
    expect(args).toBeDefined();
    expect(args![0]).toBe("compose");
    expect(args).toContain("run");
    expect(args).toContain("-d");
    const nameIdx = args!.indexOf("--name");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(args![nameIdx + 1]).toMatch(/^sandcastle-/);
    expect(args![args!.length - 1]).toBe("agent");

    await handle.close();
  });

  it("uses serviceName option when provided", async () => {
    okExecFile();

    const provider = dockerCompose({ serviceName: "worker" });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const args = findRunArgs();
    expect(args![args!.length - 1]).toBe("worker");

    await handle.close();
  });

  it("passes the worktree as a -v host:container volume", async () => {
    okExecFile();

    const provider = dockerCompose();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const args = findRunArgs()!;
    const idx = args.indexOf("-v");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/tmp/worktree:/home/agent/workspace");

    await handle.close();
  });

  it("passes --workdir set to the worktree sandbox path", async () => {
    okExecFile();

    const provider = dockerCompose();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const args = findRunArgs()!;
    const idx = args.indexOf("--workdir");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/home/agent/workspace");

    await handle.close();
  });

  it("does not pass --user (compose users own UID via build args)", async () => {
    okExecFile();

    const provider = dockerCompose();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const args = findRunArgs()!;
    expect(args).not.toContain("--user");

    await handle.close();
  });

  it("forwards composeFile, projectName, projectDirectory to docker compose", async () => {
    okExecFile();

    const provider = dockerCompose({
      composeFile: "package.json",
      projectName: "sandcastle-test",
      projectDirectory: "/tmp/repo",
    });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const args = findRunArgs()!;
    const fIdx = args.indexOf("-f");
    expect(fIdx).toBeGreaterThan(-1);
    expect(args[fIdx + 1]).toMatch(/package\.json$/);
    const pdIdx = args.indexOf("--project-directory");
    expect(pdIdx).toBeGreaterThan(-1);
    expect(args[pdIdx + 1]).toBe("/tmp/repo");
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("sandcastle-test");

    await handle.close();
  });

  it("copyFileIn calls docker cp with correct arguments", async () => {
    okExecFile();

    const provider = dockerCompose();
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
    expect(cpArgs[2]).toMatch(/^sandcastle-.*:\/sandbox\/file\.txt$/);

    await handle.close();
  });

  it("copyFileOut calls docker cp with correct arguments", async () => {
    okExecFile();

    const provider = dockerCompose();
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
    expect(cpArgs[1]).toMatch(/^sandcastle-.*:\/sandbox\/output\.txt$/);

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

    const provider = dockerCompose();
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
