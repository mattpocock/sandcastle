import { execFile, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { BindMountSandboxHandle } from "../SandboxProvider.js";
import { appleContainer, defaultImageName } from "./apple-container.js";

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

const mockExecFile = vi.mocked(execFile);
const mockExecFileSync = vi.mocked(execFileSync);
const mockSpawn = vi.mocked(spawn);
const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;
const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch")!;
const testRoot = mkdtempSync(join(tmpdir(), "apple-container-provider-test-"));
const testWorktreePath = join(testRoot, "worktree");
const testRepoPath = join(testRoot, "repo");
mkdirSync(testWorktreePath);
mkdirSync(testRepoPath);

const createOptions = {
  worktreePath: testWorktreePath,
  hostRepoPath: testRepoPath,
  mounts: [
    {
      hostPath: testWorktreePath,
      sandboxPath: "/home/agent/workspace",
    },
  ],
  env: { TOKEN: "secret" },
};

const hostIdentity = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
const imageInspectOutput = (user: string) =>
  JSON.stringify([
    {
      variants: [
        {
          config: {
            architecture: "arm64",
            config: { User: user },
          },
          platform: { architecture: "arm64" },
        },
      ],
    },
  ]);

const makeCommandsSucceed = (imageUser = hostIdentity) => {
  mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
    const callback = rest.at(-1) as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    const stdout =
      Array.isArray(args) && args[0] === "image" && args[1] === "inspect"
        ? imageInspectOutput(imageUser)
        : "";
    callback(null, stdout, "");
    return undefined as never;
  });
};

const makeCopiesSucceed = (copyOutContents: string) => {
  mockSpawn.mockImplementation((_command, args) => {
    const proc = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = vi.fn();

    if ((args as string[]).includes("--interactive")) {
      proc.stdin.resume();
      proc.stdin.on("finish", () => {
        proc.emit("close", 0, null);
      });
    } else {
      queueMicrotask(() => {
        proc.stdout.end(copyOutContents, () => {
          proc.emit("close", 0, null);
        });
      });
    }

    return proc as never;
  });
};

beforeEach(() => {
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "darwin",
  });
  Object.defineProperty(process, "arch", {
    ...archDescriptor,
    value: "arm64",
  });
});

afterEach(() => {
  mockExecFile.mockReset();
  mockExecFileSync.mockReset();
  mockSpawn.mockReset();
  Object.defineProperty(process, "platform", platformDescriptor);
  Object.defineProperty(process, "arch", archDescriptor);
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("appleContainer()", () => {
  it("returns a bind-mount provider with provider-level environment", () => {
    const provider = appleContainer({ env: { APPLE_CONTAINER: "true" } });

    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("apple-container");
    expect(provider.env).toEqual({ APPLE_CONTAINER: "true" });
    if (provider.tag === "bind-mount") {
      expect(provider.sandboxHomedir).toBe("/home/agent");
    }
  });

  it("fails before invoking the CLI on unsupported hosts", async () => {
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "linux",
    });

    await expect(appleContainer().create(createOptions)).rejects.toThrow(
      "requires macOS on Apple silicon",
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("fails before invoking the CLI on Intel Macs", async () => {
    Object.defineProperty(process, "arch", {
      ...archDescriptor,
      value: "x64",
    });

    await expect(appleContainer().create(createOptions)).rejects.toThrow(
      "requires macOS on Apple silicon",
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("distinguishes a missing CLI from stopped services", async () => {
    const missing = Object.assign(new Error("spawn container ENOENT"), {
      code: "ENOENT",
    });
    mockExecFile.mockImplementationOnce((_command, _args, callback) => {
      (callback as (error: Error) => void)(missing);
      return undefined as never;
    });

    await expect(appleContainer().create(createOptions)).rejects.toThrow(
      "CLI was not found on PATH",
    );

    mockExecFile.mockImplementationOnce((_command, _args, callback) => {
      (callback as (error: Error) => void)(new Error("service unavailable"));
      return undefined as never;
    });

    await expect(appleContainer().create(createOptions)).rejects.toThrow(
      "container system start",
    );
  });

  it("fails loudly when the configured image is unavailable", async () => {
    mockExecFile
      .mockImplementationOnce((_command, _args, callback) => {
        (callback as (error: null) => void)(null);
        return undefined as never;
      })
      .mockImplementationOnce((_command, _args, callback) => {
        (callback as (error: Error) => void)(new Error("not found"));
        return undefined as never;
      });

    await expect(
      appleContainer({ imageName: "sandcastle:missing" }).create(createOptions),
    ).rejects.toThrow("sandcastle apple-container build-image");
  });

  it("fails loudly when image metadata cannot be validated", async () => {
    mockExecFile
      .mockImplementationOnce((_command, _args, callback) => {
        (callback as (error: null) => void)(null);
        return undefined as never;
      })
      .mockImplementationOnce((_command, _args, callback) => {
        (callback as (error: null, stdout: string, stderr: string) => void)(
          null,
          "not-json",
          "",
        );
        return undefined as never;
      });

    await expect(appleContainer().create(createOptions)).rejects.toThrow(
      "unexpected metadata",
    );
  });

  it("rejects images built for a different numeric identity", async () => {
    makeCommandsSucceed("502:21");

    await expect(
      appleContainer({
        imageName: "sandcastle:test",
        containerUid: 501,
        containerGid: 20,
      }).create(createOptions),
    ).rejects.toThrow("Image identity mismatch");
    expect(
      mockExecFile.mock.calls.some(
        ([, args]) => Array.isArray(args) && args[0] === "run",
      ),
    ).toBe(false);
  });

  it("maps provider options and mounts to native run flags", async () => {
    makeCommandsSucceed("501:20");
    const provider = appleContainer({
      imageName: "sandcastle:test",
      containerUid: 501,
      containerGid: 20,
      mounts: [
        {
          hostPath: "~",
          sandboxPath: "/home/agent/host-home",
          readonly: true,
        },
      ],
      network: "agents",
      cpus: 3.5,
      memory: "6G",
      ssh: true,
    });

    const handle = await provider.create(createOptions);
    const runCall = mockExecFile.mock.calls.find(
      ([command, args]) =>
        command === "container" && Array.isArray(args) && args[0] === "run",
    );
    expect(runCall).toBeDefined();

    const args = runCall![1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "--detach",
        "--user",
        "501:20",
        "--workdir",
        "/home/agent/workspace",
        "--network",
        "agents",
        "--cpus",
        "3.5",
        "--memory",
        "6G",
        "--ssh",
        "--env",
        "TOKEN=secret",
        "--env",
        "HOME=/home/agent",
        "--mount",
        `source=${testWorktreePath},target=/home/agent/workspace`,
        "--mount",
        `source=${homedir()},target=/home/agent/host-home,readonly`,
        "--entrypoint",
        "sleep",
        "sandcastle:test",
        "infinity",
      ]),
    );

    await handle.close();
    const deleteCall = mockExecFile.mock.calls.find(
      ([command, commandArgs]) =>
        command === "container" &&
        Array.isArray(commandArgs) &&
        commandArgs[0] === "delete",
    );
    expect(deleteCall?.[1]).toEqual([
      "delete",
      "--force",
      expect.stringMatching(/^sandcastle-/),
    ]);
  });

  it("streams files through exec so VirtioFS mounts are visible", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "apple-container-copy-test-"));
    const inputPath = join(tempDir, "input.txt");
    const outputPath = join(tempDir, "nested", "output.txt");
    writeFileSync(inputPath, "copy in");
    makeCommandsSucceed("501:20");
    makeCopiesSucceed("copy out");
    const handle = (await appleContainer({
      containerUid: 501,
      containerGid: 20,
    }).create(createOptions)) as BindMountSandboxHandle;

    await handle.copyFileIn(inputPath, "/sandbox/input.txt");
    await handle.copyFileOut("/sandbox/output.txt", outputPath);

    expect(readFileSync(outputPath, "utf8")).toBe("copy out");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0]![1]).toEqual([
      "exec",
      "--interactive",
      "--user",
      "501:20",
      expect.stringMatching(/^sandcastle-/),
      "sh",
      "-c",
      'mkdir -p "$(dirname "$1")" && cat > "$1"',
      "sh",
      "/sandbox/input.txt",
    ]);
    expect(mockSpawn.mock.calls[1]![1]).toEqual([
      "exec",
      "--user",
      "501:20",
      expect.stringMatching(/^sandcastle-/),
      "sh",
      "-c",
      'cat "$1"',
      "sh",
      "/sandbox/output.txt",
    ]);
    expect(
      mockExecFile.mock.calls.some(
        ([command, args]) =>
          command === "container" &&
          Array.isArray(args) &&
          (args[0] === "cp" || args[0] === "copy"),
      ),
    ).toBe(false);

    await handle.close();
    unlinkSync(inputPath);
    unlinkSync(outputPath);
    rmdirSync(join(tempDir, "nested"));
    rmdirSync(tempDir);
  });

  it("rejects single-file mounts before starting a VM", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "apple-container-test-"));
    const tempFile = join(tempDir, "auth.json");
    writeFileSync(tempFile, "{}");

    expect(() =>
      appleContainer({
        mounts: [
          {
            hostPath: tempFile,
            sandboxPath: "/home/agent/.config/auth.json",
          },
        ],
      }),
    ).toThrow("require directory host paths");
    expect(mockExecFile).not.toHaveBeenCalled();

    unlinkSync(tempFile);
    rmdirSync(tempDir);
  });

  it.each([",", "="])(
    "rejects mount paths containing Apple Container's '%s' delimiter",
    (delimiter) => {
      const mountPath = join(testRoot, `invalid${delimiter}mount`);
      mkdirSync(mountPath);

      expect(() =>
        appleContainer({
          mounts: [
            {
              hostPath: mountPath,
              sandboxPath: "/home/agent/invalid",
            },
          ],
        }),
      ).toThrow("cannot represent mount source path");
      expect(mockExecFile).not.toHaveBeenCalled();

      rmdirSync(mountPath);
    },
  );

  it("rejects conflicting sources for the same mount target", async () => {
    const firstPath = join(testRoot, "first-mount");
    const secondPath = join(testRoot, "second-mount");
    mkdirSync(firstPath);
    mkdirSync(secondPath);
    makeCommandsSucceed();

    await expect(
      appleContainer().create({
        ...createOptions,
        mounts: [
          ...createOptions.mounts,
          { hostPath: firstPath, sandboxPath: "/shared" },
          { hostPath: secondPath, sandboxPath: "/shared" },
        ],
      }),
    ).rejects.toThrow("configured more than once");
    expect(
      mockExecFile.mock.calls.some(
        ([, args]) => Array.isArray(args) && args[0] === "run",
      ),
    ).toBe(false);

    rmdirSync(firstPath);
    rmdirSync(secondPath);
  });

  it("omits redundant git pointer-file mounts for nested host worktrees", async () => {
    const nestedRoot = mkdtempSync(
      join(tmpdir(), "apple-container-nested-worktree-test-"),
    );
    const nestedWorktreePath = join(nestedRoot, "sandbox-worktree");
    const nestedHostRepoPath = join(nestedRoot, "host-worktree");
    const parentGitPath = join(nestedRoot, "primary", ".git");
    const hostGitFile = join(nestedHostRepoPath, ".git");
    mkdirSync(nestedWorktreePath);
    mkdirSync(nestedHostRepoPath);
    mkdirSync(parentGitPath, { recursive: true });
    writeFileSync(
      hostGitFile,
      `gitdir: ${join(parentGitPath, "worktrees", "host-worktree")}\n`,
    );
    makeCommandsSucceed();

    const handle = await appleContainer().create({
      worktreePath: nestedWorktreePath,
      hostRepoPath: nestedHostRepoPath,
      mounts: [
        {
          hostPath: nestedWorktreePath,
          sandboxPath: "/home/agent/workspace",
        },
        { hostPath: hostGitFile, sandboxPath: hostGitFile },
        { hostPath: parentGitPath, sandboxPath: parentGitPath },
      ],
      env: {},
    });
    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    expect(runArgs).not.toContain(
      `source=${hostGitFile},target=${hostGitFile}`,
    );
    expect(runArgs).toContain(
      `source=${parentGitPath},target=${parentGitPath}`,
    );
    expect(runArgs).toContain(
      `source=${nestedHostRepoPath},target=${nestedHostRepoPath},readonly`,
    );

    await handle.close();
    rmSync(nestedRoot, { recursive: true, force: true });
  });

  it("reports signal-terminated execs as failures", async () => {
    makeCommandsSucceed();
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
      };
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      queueMicrotask(() => {
        proc.stdout.end();
        proc.stderr.end();
        proc.emit("close", null, "SIGKILL");
      });
      return proc as never;
    });
    const handle = await appleContainer().create(createOptions);

    const buffered = await handle.exec("true");
    const streamed = await handle.exec("true", { onLine: () => undefined });
    const interactive = await handle.interactiveExec!(["true"], {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(buffered.exitCode).toBe(1);
    expect(streamed.exitCode).toBe(1);
    expect(interactive.exitCode).toBe(1);
    await handle.close();
  });

  it("registers bounded synchronous cleanup for process shutdown", async () => {
    makeCommandsSucceed();
    const handle = await appleContainer().create(createOptions);
    const exitListeners = process.listeners("exit");
    exitListeners.at(-1)!(0);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "container",
      ["delete", "--force", expect.stringMatching(/^sandcastle-/)],
      { stdio: "ignore", timeout: 5000 },
    );

    await handle.close();
  });
});

describe("defaultImageName()", () => {
  it("derives a portable local image name", () => {
    expect(defaultImageName("/Users/example/My Project")).toBe(
      "sandcastle:my-project",
    );
  });
});
