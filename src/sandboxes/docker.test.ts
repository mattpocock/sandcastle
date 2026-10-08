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
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { docker } from "./docker.js";
import type { BindMountSandboxHandle } from "../SandboxProvider.js";

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
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

  it("accepts selinuxLabel option", () => {
    const withZ = docker({ selinuxLabel: "z" });
    const withBigZ = docker({ selinuxLabel: "Z" });
    const withFalse = docker({ selinuxLabel: false });
    expect(withZ.tag).toBe("bind-mount");
    expect(withBigZ.tag).toBe("bind-mount");
    expect(withFalse.tag).toBe("bind-mount");
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

  it("passes --group-add flags to docker run, stringifying numeric GIDs", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = docker({ groups: ["docker", 999] });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    const firstIdx = runArgs.indexOf("--group-add");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(runArgs[firstIdx + 1]).toBe("docker");
    const secondIdx = runArgs.indexOf("--group-add", firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(runArgs[secondIdx + 1]).toBe("999");

    await handle.close();
  });

  it("does not pass --group-add to docker run when groups is omitted", async () => {
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

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    expect(runArgs).not.toContain("--group-add");

    await handle.close();
  });

  it("passes --device flags to docker run in order", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = docker({ devices: ["/dev/kvm", "/dev/fuse"] });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    const firstIdx = runArgs.indexOf("--device");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(runArgs[firstIdx + 1]).toBe("/dev/kvm");
    const secondIdx = runArgs.indexOf("--device", firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(runArgs[secondIdx + 1]).toBe("/dev/fuse");

    await handle.close();
  });

  it("does not pass --device to docker run when devices is omitted", async () => {
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

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    expect(runArgs).not.toContain("--device");

    await handle.close();
  });

  it("passes --cpus flag to docker run when cpus is provided", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = docker({ cpus: 1.5 });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    const idx = runArgs.indexOf("--cpus");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("1.5");

    await handle.close();
  });

  it("does not pass --cpus to docker run when cpus is omitted", async () => {
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

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    expect(runArgs).not.toContain("--cpus");

    await handle.close();
  });

  it("passes --memory and --memory-swap flags to docker run when set", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = docker({ memory: "512m", memorySwap: "1g" });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    const memoryIdx = runArgs.indexOf("--memory");
    expect(memoryIdx).toBeGreaterThan(-1);
    expect(runArgs[memoryIdx + 1]).toBe("512m");

    const memorySwapIdx = runArgs.indexOf("--memory-swap");
    expect(memorySwapIdx).toBeGreaterThan(-1);
    expect(runArgs[memorySwapIdx + 1]).toBe("1g");

    await handle.close();
  });

  it("does not pass --memory or --memory-swap to docker run when omitted", async () => {
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

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    expect(runArgs).not.toContain("--memory");
    expect(runArgs).not.toContain("--memory-swap");

    await handle.close();
  });

  it("runs pre-flight docker image inspect before docker run", async () => {
    const callOrder: string[] = [];
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "image" && args[1] === "inspect") {
        callOrder.push("inspect");
        const hostUid = process.getuid?.() ?? 1000;
        const hostGid = process.getgid?.() ?? 1000;
        callback(null, `${hostUid}:${hostGid}\n`, "");
      } else if (Array.isArray(args) && args[0] === "run") {
        callOrder.push("run");
        callback(null, "", "");
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

    expect(callOrder).toEqual(["inspect", "run"]);

    await handle.close();
  });

  it("throws on UID mismatch between image and host", async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "image" && args[1] === "inspect") {
        callback(null, "9999:9999\n", "");
      } else {
        callback(null, "", "");
      }
      return undefined as any;
    });

    const provider = docker();

    await expect(
      provider.create({
        worktreePath: "/tmp/worktree",
        hostRepoPath: "/tmp/repo",
        mounts: [
          { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
        ],
        env: {},
      }),
    ).rejects.toThrow("UID mismatch");
  });

  it("containerUid override bypasses UID mismatch with host", async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "image" && args[1] === "inspect") {
        // Image has UID 500, which differs from host but matches containerUid
        callback(null, "500:500\n", "");
      } else {
        callback(null, "", "");
      }
      return undefined as any;
    });

    const provider = docker({ containerUid: 500, containerGid: 500 });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    // Should succeed — containerUid matches image UID
    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    expect(runCall).toBeDefined();

    await handle.close();
  });

  it("throws a clear error when image is not found locally", async () => {
    mockExecFile.mockImplementationOnce((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(new Error("no such image"), "", "");
      return undefined as any;
    });

    const provider = docker({ imageName: "my-app:latest" });

    await expect(
      provider.create({
        worktreePath: "/tmp/worktree",
        hostRepoPath: "/tmp/repo",
        mounts: [
          { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
        ],
        env: {},
      }),
    ).rejects.toThrow(
      "Image 'my-app:latest' not found locally. Build it first with 'sandcastle docker build-image'.",
    );
  });

  it("uses host UID/GID by default for --user flag", async () => {
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

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const userIdx = runArgs.indexOf("--user");
    expect(userIdx).toBeGreaterThan(-1);
    const hostUid = process.getuid?.() ?? 1000;
    const hostGid = process.getgid?.() ?? 1000;
    expect(runArgs[userIdx + 1]).toBe(`${hostUid}:${hostGid}`);

    await handle.close();
  });

  it("uses containerUid/containerGid for --user flag when provided", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = docker({ containerUid: 500, containerGid: 500 });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const userIdx = runArgs.indexOf("--user");
    expect(userIdx).toBeGreaterThan(-1);
    expect(runArgs[userIdx + 1]).toBe("500:500");

    await handle.close();
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

  it("default mounts include :z SELinux label", async () => {
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

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const vIdx = runArgs.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(runArgs[vIdx + 1]).toMatch(/:z$/);

    await handle.close();
  });

  it("selinuxLabel 'Z' produces :Z suffix on mounts", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = docker({ selinuxLabel: "Z" });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toMatch(/:Z$/);

    await handle.close();
  });

  it("selinuxLabel false produces no SELinux suffix on mounts", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = docker({ selinuxLabel: false });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/tmp/worktree:/home/agent/workspace");

    await handle.close();
  });

  it("runs mkdir+chown for file mount parent dirs after container start", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "docker-test-"));
    const tmpFile = join(tmpDir, "auth.json");
    writeFileSync(tmpFile, "{}");

    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = docker({
      mounts: [
        { hostPath: tmpFile, sandboxPath: "/home/agent/.codex/auth.json" },
      ],
    });
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    // Find the docker exec call for mkdir+chown
    const mkdirCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args[0] === "exec" &&
        args.some(
          (a: string) =>
            typeof a === "string" && a.includes("mkdir") && a.includes("chown"),
        ),
    );
    expect(mkdirCall).toBeDefined();
    const mkdirArgs = mkdirCall![1] as string[];
    // Should run as root
    expect(mkdirArgs).toContain("--user");
    expect(mkdirArgs[mkdirArgs.indexOf("--user") + 1]).toBe("0:0");
    // Script body is fixed; the dir and uid:gid are passed as argv after `sh`
    const shCmdIdx = mkdirArgs.indexOf("-c");
    const shCmd = mkdirArgs[shCmdIdx + 1]!;
    expect(shCmd).toContain("mkdir -p");
    expect(shCmd).toContain("chown");
    expect(mkdirArgs).toContain("/home/agent/.codex");

    unlinkSync(tmpFile);
    rmdirSync(tmpDir);
    await handle.close();
  });

  it("does not run mkdir+chown when there are no file mounts", async () => {
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

    // Should NOT have any docker exec for mkdir
    const mkdirCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args[0] === "exec" &&
        args.some((a: string) => typeof a === "string" && a.includes("mkdir")),
    );
    expect(mkdirCall).toBeUndefined();

    await handle.close();
  });

  it("throws at construction time for file mount with parent outside /home/agent", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "docker-test-"));
    const tmpFile = join(tmpDir, "config.json");
    writeFileSync(tmpFile, "{}");

    expect(() =>
      docker({
        mounts: [{ hostPath: tmpFile, sandboxPath: "/opt/foo/config.json" }],
      }),
    ).toThrow(/outside the sandbox home directory/);

    unlinkSync(tmpFile);
    rmdirSync(tmpDir);
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

  it("shares a single SIGINT listener across many concurrent sandboxes", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const exitBefore = process.listenerCount("exit");

    const provider = docker();
    const handles: BindMountSandboxHandle[] = [];
    for (let i = 0; i < 12; i++) {
      handles.push(
        (await provider.create({
          worktreePath: "/tmp/worktree",
          hostRepoPath: "/tmp/repo",
          mounts: [
            { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
          ],
          env: {},
        })) as BindMountSandboxHandle,
      );
    }

    // 12 sandboxes must not add 12 listeners (which would trip Node's warning).
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    expect(process.listenerCount("exit")).toBe(exitBefore + 1);

    for (const h of handles) await h.close();

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("exit")).toBe(exitBefore);
  });
});
