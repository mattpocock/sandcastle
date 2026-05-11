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

import { execFile, execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { podman, defaultImageName } from "./podman.js";
import type { BindMountSandboxHandle } from "../SandboxProvider.js";

const mockExecFile = vi.mocked(execFile);
const mockExecFileSync = vi.mocked(execFileSync);

afterEach(() => {
  mockExecFile.mockReset();
});

describe("podman()", () => {
  it("returns a SandboxProvider with tag 'bind-mount' and name 'podman'", () => {
    const provider = podman();
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("podman");
  });

  it("accepts an imageName option", () => {
    const provider = podman({ imageName: "my-image:latest" });
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("podman");
  });

  it("has a create function", () => {
    const provider = podman();
    expect(typeof provider.create).toBe("function");
  });

  it("accepts selinuxLabel option", () => {
    // Just verify construction succeeds with each option
    const withZ = podman({ selinuxLabel: "z" });
    const withBigZ = podman({ selinuxLabel: "Z" });
    const withFalse = podman({ selinuxLabel: false });
    expect(withZ.tag).toBe("bind-mount");
    expect(withBigZ.tag).toBe("bind-mount");
    expect(withFalse.tag).toBe("bind-mount");
  });

  it("accepts a mounts option with valid paths", () => {
    const provider = podman({
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("throws at construction time if a mount hostPath does not exist", () => {
    expect(() =>
      podman({
        mounts: [
          {
            hostPath: "/nonexistent/path/does/not/exist",
            sandboxPath: "/mnt/cache",
          },
        ],
      }),
    ).toThrow("Mount hostPath does not exist");
  });

  it("resolves relative hostPath against process.cwd()", () => {
    const provider = podman({
      mounts: [{ hostPath: "src", sandboxPath: "/mnt/src" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("resolves dot-prefixed relative hostPath against process.cwd()", () => {
    const provider = podman({
      mounts: [{ hostPath: "./src", sandboxPath: "/mnt/src" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("throws for relative hostPath that does not exist", () => {
    expect(() =>
      podman({
        mounts: [{ hostPath: "nonexistent_dir_xyz", sandboxPath: "/mnt/data" }],
      }),
    ).toThrow("Mount hostPath does not exist");
  });

  it("resolves relative sandboxPath against sandbox repo dir", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
      selinuxLabel: false,
      mounts: [{ hostPath: "src", sandboxPath: "data" }],
    });

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

    // sandboxPath "data" should resolve to /home/agent/workspace/data
    const srcMount = runArgs?.find((arg: string) =>
      arg.includes("/home/agent/workspace/data"),
    );
    expect(srcMount).toBeDefined();

    await handle.close();
  });

  it("accepts an env option", () => {
    const provider = podman({ env: { MY_VAR: "hello" } });
    expect(provider.tag).toBe("bind-mount");
    expect(provider.env).toEqual({ MY_VAR: "hello" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = podman();
    expect(provider.env).toEqual({});
  });

  it("formats readonly SELinux mounts as :ro,z", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
      selinuxLabel: "z",
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home", readonly: true }],
    });

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
    )?.[1];

    expect(runArgs).toContain(`${homedir()}:/mnt/home:ro,z`);

    await handle.close();
  });

  it("formats writable SELinux mounts as :z", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
      selinuxLabel: "z",
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home" }],
    });

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
    )?.[1];

    expect(runArgs).toContain(`${homedir()}:/mnt/home:z`);

    await handle.close();
  });

  it("formats readonly mounts without SELinux as :ro", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
      selinuxLabel: false,
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home", readonly: true }],
    });

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
    )?.[1];

    expect(runArgs).toContain(`${homedir()}:/mnt/home:ro`);

    await handle.close();
  });

  it("formats mounts with no options when writable and no SELinux", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
      selinuxLabel: false,
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home" }],
    });

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
    )?.[1];

    expect(runArgs).toContain(`${homedir()}:/mnt/home`);
    // Should NOT have any trailing options
    expect(runArgs).not.toContain(`${homedir()}:/mnt/home:`);

    await handle.close();
  });

  it("passes --userns=keep-id by default", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman();
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

    expect(runArgs).toContain("--userns=keep-id:uid=1000,gid=1000");

    await handle.close();
  });

  it("passes custom containerUid/containerGid to --userns and --user", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({ containerUid: 500, containerGid: 500 });
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

    expect(runArgs).toContain("--userns=keep-id:uid=500,gid=500");
    const userIdx = runArgs.indexOf("--user");
    expect(runArgs[userIdx + 1]).toBe("500:500");

    await handle.close();
  });

  it("allows disabling userns via option", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({ userns: false });
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

    expect(runArgs).not.toContain("--userns=keep-id:uid=1000,gid=1000");

    await handle.close();
  });

  it("throws a clear error when image is not found locally", async () => {
    // First call is podman image inspect — fail it
    mockExecFile.mockImplementationOnce((_command, _args, callback: any) => {
      callback(new Error("no such image"), "", "");
      return undefined as any;
    });

    const provider = podman({ imageName: "my-app:latest" });

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
      "Image 'my-app:latest' not found locally. Build it first with 'podman build -t my-app:latest .'",
    );
  });

  it("checks for Podman Machine on macOS", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      // podman machine list returns no running machines
      mockExecFile.mockImplementationOnce((_command, _args, callback: any) => {
        callback(null, "[]", "");
        return undefined as any;
      });

      const provider = podman();

      await expect(
        provider.create({
          worktreePath: "/tmp/worktree",
          hostRepoPath: "/tmp/repo",
          mounts: [
            { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
          ],
          env: {},
        }),
      ).rejects.toThrow("Podman Machine is not running");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("accepts a network option as a string", () => {
    const provider = podman({ network: "my-network" });
    expect(provider.tag).toBe("bind-mount");
  });

  it("accepts a network option as an array", () => {
    const provider = podman({ network: ["net1", "net2"] });
    expect(provider.tag).toBe("bind-mount");
  });

  it("passes --network flag when network is a string", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({ network: "my-network" });
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

    const networkIdx = runArgs.indexOf("--network");
    expect(networkIdx).toBeGreaterThan(-1);
    expect(runArgs[networkIdx + 1]).toBe("my-network");

    await handle.close();
  });

  it("passes multiple --network flags when network is an array", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({ network: ["net1", "net2"] });
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

    const firstIdx = runArgs.indexOf("--network");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(runArgs[firstIdx + 1]).toBe("net1");
    const secondIdx = runArgs.indexOf("--network", firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(runArgs[secondIdx + 1]).toBe("net2");

    await handle.close();
  });

  it("does not pass --network flag when network is omitted", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman();
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

    expect(runArgs).not.toContain("--network");

    await handle.close();
  });

  it("does not run chown after container start", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    // Verify no chown exec call was made
    const chownCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "podman" && Array.isArray(args) && args.includes("chown"),
    );
    expect(chownCall).toBeUndefined();

    await handle.close();
  });

  it("copyFileIn calls podman cp with correct arguments", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman();
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
        cmd === "podman" &&
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

  it("copyFileOut calls podman cp with correct arguments", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman();
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
        cmd === "podman" &&
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

  it("copyFileIn rejects when podman cp fails", async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "cp") {
        callback(new Error("no such file"));
      } else {
        callback(null, "", "");
      }
      return undefined as any;
    });

    const provider = podman();
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
    ).rejects.toThrow("podman cp (in) failed");

    await handle.close();
  });

  it("runs mkdir+chown for file mount parent dirs after container start", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "podman-test-"));
    const tmpFile = join(tmpDir, "auth.json");
    writeFileSync(tmpFile, "{}");

    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
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

    // Find the podman exec call for mkdir+chown
    const mkdirCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "podman" &&
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
    expect(mkdirArgs).toContain("1000:1000");

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

    const provider = podman();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    // Should NOT have any podman exec for mkdir
    const mkdirCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "podman" &&
        Array.isArray(args) &&
        args[0] === "exec" &&
        args.some((a: string) => typeof a === "string" && a.includes("mkdir")),
    );
    expect(mkdirCall).toBeUndefined();

    await handle.close();
  });

  it("throws at construction time for file mount with parent outside /home/agent", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "podman-test-"));
    const tmpFile = join(tmpDir, "config.json");
    writeFileSync(tmpFile, "{}");

    expect(() =>
      podman({
        mounts: [{ hostPath: tmpFile, sandboxPath: "/opt/foo/config.json" }],
      }),
    ).toThrow(/outside the sandbox home directory/);

    unlinkSync(tmpFile);
    rmdirSync(tmpDir);
  });

  it("includes timeout on signal handler cleanup", async () => {
    // Allow image inspect + podman run to succeed
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman();
    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    // Trigger a registered exit handler
    const exitListeners = process.listeners("exit");
    const sandcastleListener = exitListeners[exitListeners.length - 1];
    sandcastleListener!(0);

    // Check that execFileSync was called with timeout option
    const rmCall = mockExecFileSync.mock.calls.find(
      ([cmd, args]) =>
        cmd === "podman" && Array.isArray(args) && args[0] === "rm",
    );
    expect(rmCall).toBeDefined();
    expect(rmCall![2]).toMatchObject({ timeout: 5000 });

    await handle.close();
  });
});

describe("defaultImageName()", () => {
  it("derives image name from repo directory", () => {
    expect(defaultImageName("/home/user/my-repo")).toBe("sandcastle:my-repo");
  });

  it("lowercases and sanitizes the directory name", () => {
    expect(defaultImageName("/home/user/My Repo!")).toBe("sandcastle:my-repo-");
  });

  it("handles trailing slashes", () => {
    expect(defaultImageName("/home/user/repo/")).toBe("sandcastle:repo");
  });

  it("falls back to 'local' for empty path", () => {
    expect(defaultImageName("")).toBe("sandcastle:local");
  });
});
