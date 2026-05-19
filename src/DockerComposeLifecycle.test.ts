import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execFile } from "node:child_process";
import { startContainer, removeContainer } from "./DockerComposeLifecycle.js";

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
});

const okExecFile = () => {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    cb(null, "", "");
    return undefined as any;
  });
};

const findCall = (predicate: (args: string[]) => boolean) =>
  mockExecFile.mock.calls.find(
    ([, args]) => Array.isArray(args) && predicate(args as string[]),
  );

const findRunCall = () =>
  findCall((args) => args[0] === "compose" && args.includes("run"));

describe("DockerComposeLifecycle.startContainer", () => {
  it("invokes 'docker compose run -d --name <name> <service>'", async () => {
    okExecFile();

    await Effect.runPromise(
      startContainer("ctr", "agent", {}, { projectDirectory: "/repo" }),
    );

    const runCall = findRunCall();
    expect(runCall).toBeDefined();
    const args = runCall![1] as string[];
    expect(args[0]).toBe("compose");
    expect(args).toContain("run");
    expect(args).toContain("-d");
    const nameIdx = args.indexOf("--name");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(args[nameIdx + 1]).toBe("ctr");
    // service name is the final positional
    expect(args[args.length - 1]).toBe("agent");
  });

  it("passes --project-directory when projectDirectory is provided", async () => {
    okExecFile();

    await Effect.runPromise(
      startContainer("ctr", "agent", {}, { projectDirectory: "/repo" }),
    );

    const runCall = findRunCall();
    const args = runCall![1] as string[];
    const idx = args.indexOf("--project-directory");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/repo");
  });

  it("passes -f when composeFile is provided", async () => {
    okExecFile();

    await Effect.runPromise(
      startContainer(
        "ctr",
        "agent",
        {},
        {
          composeFile: "/repo/.sandcastle/docker-compose.yml",
        },
      ),
    );

    const runCall = findRunCall();
    const args = runCall![1] as string[];
    const idx = args.indexOf("-f");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/repo/.sandcastle/docker-compose.yml");
  });

  it("passes -p when projectName is provided", async () => {
    okExecFile();

    await Effect.runPromise(
      startContainer("ctr", "agent", {}, { projectName: "sandcastle-abc" }),
    );

    const runCall = findRunCall();
    const args = runCall![1] as string[];
    const idx = args.indexOf("-p");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("sandcastle-abc");
  });

  it("passes --workdir when workdir is provided", async () => {
    okExecFile();

    await Effect.runPromise(
      startContainer("ctr", "agent", {}, { workdir: "/home/agent/workspace" }),
    );

    const runCall = findRunCall();
    const args = runCall![1] as string[];
    const idx = args.indexOf("--workdir");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/home/agent/workspace");
  });

  it("passes -e flags for env vars", async () => {
    okExecFile();

    await Effect.runPromise(
      startContainer("ctr", "agent", { FOO: "bar", BAZ: "qux" }),
    );

    const runCall = findRunCall();
    const args = runCall![1] as string[];
    const fooIdx = args.findIndex((a) => a === "FOO=bar");
    expect(fooIdx).toBeGreaterThan(-1);
    expect(args[fooIdx - 1]).toBe("-e");
    const bazIdx = args.findIndex((a) => a === "BAZ=qux");
    expect(bazIdx).toBeGreaterThan(-1);
    expect(args[bazIdx - 1]).toBe("-e");
  });

  it("uses -v host:container for volume mounts (compose run rejects --mount)", async () => {
    okExecFile();

    await Effect.runPromise(
      startContainer(
        "ctr",
        "agent",
        {},
        {
          volumeMounts: [
            { hostPath: "/host/path", sandboxPath: "/sandbox/path" },
          ],
        },
      ),
    );

    const runCall = findRunCall();
    const args = runCall![1] as string[];
    expect(args).not.toContain("--mount");
    expect(args).toContain("-v");
    const idx = args.indexOf("-v");
    expect(args[idx + 1]).toBe("/host/path:/sandbox/path");
  });

  it("handles Windows-style host paths with drive-letter colons in -v", async () => {
    okExecFile();

    await Effect.runPromise(
      startContainer(
        "ctr",
        "agent",
        {},
        {
          volumeMounts: [
            {
              hostPath: "C:/Users/x/repo",
              sandboxPath: "/home/agent/workspace",
            },
          ],
        },
      ),
    );

    const runCall = findRunCall();
    const args = runCall![1] as string[];
    const idx = args.indexOf("-v");
    expect(args[idx + 1]).toBe("C:/Users/x/repo:/home/agent/workspace");
  });

  it("appends :ro suffix for read-only mounts", async () => {
    okExecFile();

    await Effect.runPromise(
      startContainer(
        "ctr",
        "agent",
        {},
        {
          volumeMounts: [
            {
              hostPath: "/host/path",
              sandboxPath: "/sandbox/path",
              readonly: true,
            },
          ],
        },
      ),
    );

    const runCall = findRunCall();
    const args = runCall![1] as string[];
    const idx = args.indexOf("-v");
    expect(args[idx + 1]).toBe("/host/path:/sandbox/path:ro");
  });

  it("does not pass UID-related flags (compose owns it via build args)", async () => {
    okExecFile();

    await Effect.runPromise(startContainer("ctr", "agent", {}));

    const runCall = findRunCall();
    const args = runCall![1] as string[];
    expect(args).not.toContain("--user");
  });

  it("checks for existing container before run and rejects if present", async () => {
    mockExecFile.mockImplementation((_cmd, args, _opts, cb: any) => {
      if (Array.isArray(args) && args[0] === "ps") {
        cb(null, "ctr\n", "");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await expect(
      Effect.runPromise(startContainer("ctr", "agent", {})),
    ).rejects.toThrow(/already exists/);
  });
});

describe("DockerComposeLifecycle.removeContainer", () => {
  it("calls docker stop then docker rm with the container name", async () => {
    okExecFile();

    await Effect.runPromise(removeContainer("ctr"));

    const stopCall = findCall((args) => args[0] === "stop");
    expect(stopCall).toBeDefined();
    expect((stopCall![1] as string[])[1]).toBe("ctr");

    const rmCall = findCall((args) => args[0] === "rm" && args[1] === "ctr");
    expect(rmCall).toBeDefined();
  });

  it("ignores errors from stop and rm (best-effort cleanup)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(new Error("not found"), "", "");
      return undefined as any;
    });

    await expect(
      Effect.runPromise(removeContainer("ctr")),
    ).resolves.toBeUndefined();
  });
});
