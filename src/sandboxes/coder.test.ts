import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );

  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from "node:child_process";
import { coder, type CoderOptions } from "./coder.js";

const mockSpawn = vi.mocked(spawn);

const spawnResult = (options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  onStdin?: (stdin: string) => void;
}) => {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();

  const stdinChunks: Buffer[] = [];
  const originalWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = ((chunk: unknown, ...args: unknown[]) => {
    stdinChunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
    );
    return originalWrite(chunk as any, ...(args as []));
  }) as typeof proc.stdin.write;
  const originalEnd = proc.stdin.end.bind(proc.stdin);
  proc.stdin.end = ((chunk?: unknown, ...args: unknown[]) => {
    if (chunk !== undefined) {
      stdinChunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
      );
    }
    options.onStdin?.(Buffer.concat(stdinChunks).toString());
    return originalEnd(chunk as any, ...(args as []));
  }) as typeof proc.stdin.end;

  queueMicrotask(() => {
    if (options.stdout) proc.stdout.write(options.stdout);
    if (options.stderr) proc.stderr.write(options.stderr);
    proc.stdout.end();
    proc.stderr.end();
    proc.emit("close", options.exitCode ?? 0);
  });

  return proc as any;
};

/**
 * Detect a `coder ssh` invocation that is exercising the readiness probe
 * (`waitForSshReady`). The probe runs `sh -c 'printf ready'` on the remote
 * before any real exec, so existing test mocks need to return `"ready"` on
 * stdout to satisfy the `endsWith("ready")` check.
 */
const isSshReadinessProbe = (coderArgs: readonly string[]): boolean => {
  if (coderArgs[0] !== "ssh") return false;
  const remoteCommand = coderArgs.at(-1);
  return (
    typeof remoteCommand === "string" && remoteCommand.includes("printf ready")
  );
};

const workspaceJson = (
  name: string,
  options?: {
    status?: string;
    agents?: Array<{ name: string; status?: string; directory?: string }>;
    resources?: Array<{
      agents?: Array<{ name: string; status?: string; directory?: string }>;
    }>;
  },
) =>
  JSON.stringify([
    {
      id: "workspace-id",
      name,
      owner_name: "me",
      latest_build: {
        status: options?.status ?? "running",
        resources: options?.resources ?? [
          {
            agents: options?.agents ?? [
              {
                name: "dev",
                status: "connected",
                directory: "/home/coder/project",
              },
            ],
          },
        ],
      },
    },
  ]);

beforeEach(() => {
  mockSpawn.mockReset();
});

describe("coder()", () => {
  it("returns an isolated SandboxProvider for create mode", () => {
    const provider = coder({ template: "node", onClose: "delete" });

    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("coder");
  });

  it("returns an isolated SandboxProvider for attach mode", () => {
    const provider = coder({ workspace: "my-ws", onClose: "leave" });

    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("coder");
  });

  it("stores env and defaults env to an empty object", () => {
    expect(coder({ workspace: "my-ws", onClose: "leave" }).env).toEqual({});
    expect(
      coder({ workspace: "my-ws", onClose: "leave", env: { FOO: "bar" } }).env,
    ).toEqual({ FOO: "bar" });
  });

  it("accepts create and attach specific options", () => {
    expect(
      coder({
        template: "node",
        onClose: "stop",
        templateVersion: "v1",
        parameters: { region: "us", cpus: 2, ephemeral: false },
        parameterFile: "params.yaml",
        preset: "small",
        workspaceName: "sandcastle-manual",
        organization: "org-a",
        workspaceAgent: "dev",
        workdir: "/tmp/sandcastle",
      }).tag,
    ).toBe("isolated");

    expect(
      coder({
        workspace: "my-ws",
        owner: "me",
        onClose: "leave",
        workspaceAgent: "dev",
        workdir: "/tmp/sandcastle",
      }).tag,
    ).toBe("isolated");
  });

  it("rejects invalid option shapes at compile time", () => {
    const createOptions: CoderOptions = { template: "node", onClose: "delete" };
    const attachOptions: CoderOptions = {
      workspace: "my-ws",
      onClose: "leave",
    };

    // @ts-expect-error template and workspace are mutually exclusive
    const both: CoderOptions = {
      template: "node",
      workspace: "my-ws",
      onClose: "leave",
    };

    // @ts-expect-error onClose is required
    const missingOnClose: CoderOptions = { template: "node" };

    void createOptions;
    void attachOptions;
    void both;
    void missingOnClose;
  });

  it("creates a Coder workspace from a template and uses the workspace agent directory as the worktree", async () => {
    let createdName = "sandcastle-test";
    mockSpawn.mockImplementation((_command, args) => {
      const coderArgs = args as string[];
      if (coderArgs[0] === "whoami") {
        return spawnResult({ stdout: JSON.stringify([{ username: "me" }]) });
      }
      if (coderArgs[0] === "create") {
        createdName = coderArgs[1]!;
        return spawnResult({});
      }
      if (coderArgs[0] === "list") {
        return spawnResult({ stdout: workspaceJson(createdName) });
      }
      if (coderArgs[0] === "ssh") {
        if (isSshReadinessProbe(coderArgs)) {
          return spawnResult({ stdout: "ready" });
        }
        return spawnResult({});
      }
      if (coderArgs[0] === "delete") {
        return spawnResult({});
      }
      return spawnResult({ exitCode: 1, stderr: `unexpected ${coderArgs[0]}` });
    });

    const provider = coder({ template: "node", onClose: "delete" });
    const handle = await provider.create({ env: {} });
    await handle.close();

    expect(handle.worktreePath).toBe(
      "/home/coder/project/.sandcastle/worktree",
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      "coder",
      expect.arrayContaining(["create", createdName, "--template", "node"]),
      expect.anything(),
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      "coder",
      ["delete", `me/${createdName}`, "--yes"],
      expect.anything(),
    );
  });

  it("waits for Coder workspace agents to appear after create", async () => {
    let createdName = "sandcastle-test";
    let listCalls = 0;
    mockSpawn.mockImplementation((_command, args) => {
      const coderArgs = args as string[];
      if (coderArgs[0] === "whoami") {
        return spawnResult({ stdout: JSON.stringify([{ username: "me" }]) });
      }
      if (coderArgs[0] === "create") {
        createdName = coderArgs[1]!;
        return spawnResult({});
      }
      if (coderArgs[0] === "list") {
        listCalls += 1;
        return spawnResult({
          stdout:
            listCalls === 1
              ? workspaceJson(createdName, { resources: [{ agents: [] }] })
              : workspaceJson(createdName),
        });
      }
      if (coderArgs[0] === "ssh") {
        if (isSshReadinessProbe(coderArgs)) {
          return spawnResult({ stdout: "ready" });
        }
        return spawnResult({});
      }
      return spawnResult({ exitCode: 1, stderr: `unexpected ${coderArgs[0]}` });
    });

    const provider = coder({
      template: "node",
      workspaceName: "sandcastle-agent-delay",
      onClose: "leave",
    });
    const handle = await provider.create({ env: {} });

    expect(handle.worktreePath).toBe(
      "/home/coder/project/.sandcastle/worktree",
    );
    expect(listCalls).toBe(2);
  });

  it("attaches to a stopped Coder workspace, starts it, and leaves it on close", async () => {
    let listCalls = 0;
    mockSpawn.mockImplementation((_command, args) => {
      const coderArgs = args as string[];
      if (coderArgs[0] === "whoami") {
        return spawnResult({ stdout: JSON.stringify([{ username: "me" }]) });
      }
      if (coderArgs[0] === "list") {
        listCalls += 1;
        return spawnResult({
          stdout:
            listCalls === 1
              ? workspaceJson("my-ws", { status: "stopped" })
              : workspaceJson("my-ws"),
        });
      }
      if (coderArgs[0] === "start") {
        return spawnResult({});
      }
      if (coderArgs[0] === "ssh") {
        if (isSshReadinessProbe(coderArgs)) {
          return spawnResult({ stdout: "ready" });
        }
        return spawnResult({});
      }
      return spawnResult({ exitCode: 1, stderr: `unexpected ${coderArgs[0]}` });
    });

    const provider = coder({ workspace: "my-ws", onClose: "leave" });
    const handle = await provider.create({ env: {} });
    await handle.close();

    expect(handle.worktreePath).toBe(
      "/home/coder/project/.sandcastle/worktree",
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      "coder",
      ["start", "me/my-ws", "--yes"],
      expect.anything(),
    );
    expect(
      mockSpawn.mock.calls.some(([, args]) =>
        ["delete", "stop"].includes((args as string[])[0]!),
      ),
    ).toBe(false);
  });

  it("requires workspaceAgent when a Coder workspace has multiple workspace agents", async () => {
    mockSpawn.mockImplementation((_command, args) => {
      const coderArgs = args as string[];
      if (coderArgs[0] === "whoami") {
        return spawnResult({ stdout: JSON.stringify([{ username: "me" }]) });
      }
      if (coderArgs[0] === "list") {
        return spawnResult({
          stdout: workspaceJson("multi", {
            agents: [
              {
                name: "dev",
                status: "connected",
                directory: "/home/coder/dev",
              },
              { name: "db", status: "connected", directory: "/home/coder/db" },
            ],
          }),
        });
      }
      return spawnResult({});
    });

    const provider = coder({ workspace: "multi", onClose: "leave" });

    await expect(provider.create({ env: {} })).rejects.toThrow(
      "has multiple workspace agents (dev, db)",
    );
  });

  it("executes non-stdin commands through coder ssh with env, cwd, sudo, and line streaming", async () => {
    mockSpawn.mockImplementation((command, args) => {
      const coderArgs = args as string[];
      if (command !== "coder") {
        return spawnResult({
          exitCode: 1,
          stderr: `unexpected spawn target ${String(command)}`,
        });
      }
      if (coderArgs[0] === "whoami") {
        return spawnResult({ stdout: JSON.stringify([{ username: "me" }]) });
      }
      if (coderArgs[0] === "list") {
        return spawnResult({ stdout: workspaceJson("my-ws") });
      }
      if (coderArgs[0] === "ssh") {
        if (isSshReadinessProbe(coderArgs)) {
          return spawnResult({ stdout: "ready" });
        }
        const remoteCommand = coderArgs.at(-1) ?? "";
        if (remoteCommand.includes("sudo printf hi")) {
          return spawnResult({
            stdout: "line1\nline2\n",
            exitCode: 7,
          });
        }
        return spawnResult({});
      }
      return spawnResult({ exitCode: 1, stderr: `unexpected ${coderArgs[0]}` });
    });

    const provider = coder({ workspace: "my-ws", onClose: "leave" });
    const handle = await provider.create({ env: { API_KEY: "secret" } });
    const lines: string[] = [];

    const result = await handle.exec("printf hi", {
      cwd: "/tmp/dir with space",
      sudo: true,
      onLine: (line) => lines.push(line),
    });

    expect(result).toEqual({ stdout: "line1\nline2", stderr: "", exitCode: 7 });
    expect(lines).toEqual(["line1", "line2"]);
    const sshCall = mockSpawn.mock.calls.find(
      ([command, args]) =>
        command === "coder" &&
        Array.isArray(args) &&
        args[0] === "ssh" &&
        args.includes("API_KEY=secret"),
    );
    expect(sshCall).toBeDefined();
    const sshArgs = sshCall![1] as string[];
    expect(sshArgs).toEqual(
      expect.arrayContaining(["--env", "API_KEY=secret", "me/my-ws.dev", "--"]),
    );
    expect(sshArgs.at(-1)).toContain("/tmp/dir with space");
    expect(sshArgs.at(-1)).toContain("sudo printf hi");
  });

  it("routes stdin-bearing exec through OpenSSH ProxyCommand to propagate EOF", async () => {
    let stdin = "";
    mockSpawn.mockImplementation((command, args) => {
      const argv = args as string[];
      if (command === "coder") {
        if (argv[0] === "whoami") {
          return spawnResult({ stdout: JSON.stringify([{ username: "me" }]) });
        }
        if (argv[0] === "list") {
          return spawnResult({ stdout: workspaceJson("my-ws") });
        }
        if (argv[0] === "ssh") {
          if (isSshReadinessProbe(argv)) {
            return spawnResult({ stdout: "ready" });
          }
          // Setup helpers (mkdir) still go through coder ssh.
          return spawnResult({});
        }
        return spawnResult({
          exitCode: 1,
          stderr: `unexpected coder arg ${argv[0]}`,
        });
      }
      if (command === "ssh") {
        // Stdin-bearing exec must route through OpenSSH so EOF propagates.
        return spawnResult({
          stdout: "got-payload\n",
          exitCode: 0,
          onStdin: (value) => {
            stdin = value;
          },
        });
      }
      return spawnResult({
        exitCode: 1,
        stderr: `unexpected spawn target ${String(command)}`,
      });
    });

    const provider = coder({ workspace: "my-ws", onClose: "leave" });
    const handle = await provider.create({ env: { API_KEY: "secret" } });

    const result = await handle.exec("cat", {
      cwd: "/home/coder/project",
      stdin: "payload",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("got-payload\n");
    expect(stdin).toBe("payload");

    const sshCall = mockSpawn.mock.calls.find(([cmd]) => cmd === "ssh");
    expect(sshCall).toBeDefined();
    const sshArgs = sshCall![1] as string[];
    expect(sshArgs).toEqual(
      expect.arrayContaining([
        "-o",
        "ProxyCommand=coder ssh --stdio --hostname-suffix coder %h",
        "me--my-ws.dev.coder",
      ]),
    );
    // env vars are scoped via shell prefix on the OpenSSH side because OpenSSH
    // has no `--env` flag; the prefix is single-quoted to survive whitespace.
    const remoteCommand = sshArgs.at(-1) ?? "";
    expect(remoteCommand).toContain("API_KEY='secret'");
    expect(remoteCommand).toContain("/home/coder/project");
    expect(remoteCommand).toContain("cat");
  });

  it("retries SSH readiness probe when first attempt fails (prebuild claim race)", async () => {
    let probeAttempts = 0;
    mockSpawn.mockImplementation((_command, args) => {
      const coderArgs = args as string[];
      if (coderArgs[0] === "whoami") {
        return spawnResult({ stdout: JSON.stringify([{ username: "me" }]) });
      }
      if (coderArgs[0] === "create") {
        return spawnResult({});
      }
      if (coderArgs[0] === "list") {
        return spawnResult({ stdout: workspaceJson("ws-prebuild-race") });
      }
      if (coderArgs[0] === "ssh") {
        if (isSshReadinessProbe(coderArgs)) {
          probeAttempts += 1;
          if (probeAttempts === 1) {
            // First attempt hits the disconnecting prebuild agent.
            return spawnResult({
              exitCode: 1,
              stderr: "error: agent is shutting down\n",
            });
          }
          return spawnResult({ stdout: "ready" });
        }
        return spawnResult({});
      }
      return spawnResult({ exitCode: 1, stderr: `unexpected ${coderArgs[0]}` });
    });

    const provider = coder({
      template: "with-prebuild",
      workspaceName: "ws-prebuild-race",
      onClose: "leave",
    });

    const handle = await provider.create({ env: {} });

    expect(probeAttempts).toBeGreaterThanOrEqual(2);
    expect(handle.worktreePath).toBe(
      "/home/coder/project/.sandcastle/worktree",
    );
  }, 20_000);
});
