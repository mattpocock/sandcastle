import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
  };
});

import { execFile, type ChildProcess } from "node:child_process";
import { startContainer, buildImage } from "./DockerLifecycle.js";

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
});

describe("buildImage", () => {
  it("passes --build-arg flags when buildArgs is provided", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      buildImage("my-image", "/tmp/dir", {
        buildArgs: { AGENT_UID: "1001", AGENT_GID: "1001" },
      }),
    );

    const buildCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "build",
    );
    expect(buildCall).toBeDefined();
    const buildArgs = buildCall![1] as string[];
    const uidIdx = buildArgs.indexOf("--build-arg");
    expect(uidIdx).toBeGreaterThan(-1);
    expect(buildArgs[uidIdx + 1]).toBe("AGENT_UID=1001");
    const gidIdx = buildArgs.indexOf("--build-arg", uidIdx + 1);
    expect(gidIdx).toBeGreaterThan(-1);
    expect(buildArgs[gidIdx + 1]).toBe("AGENT_GID=1001");
  });

  it("does not pass --build-arg flags when buildArgs is omitted", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(buildImage("my-image", "/tmp/dir"));

    const buildCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "build",
    );
    const buildArgs = buildCall![1] as string[];
    expect(buildArgs).not.toContain("--build-arg");
  });
});

describe("startContainer", () => {
  it("passes --network flag when network is a string", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { network: "my-network" }),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    expect(runCall).toBeDefined();
    const runArgs = runCall![1] as string[];
    const networkIdx = runArgs.indexOf("--network");
    expect(networkIdx).toBeGreaterThan(-1);
    expect(runArgs[networkIdx + 1]).toBe("my-network");
  });

  it("passes multiple --network flags when network is an array", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { network: ["net1", "net2"] }),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const firstIdx = runArgs.indexOf("--network");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(runArgs[firstIdx + 1]).toBe("net1");
    const secondIdx = runArgs.indexOf("--network", firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(runArgs[secondIdx + 1]).toBe("net2");
  });

  it("does not pass --network when network is omitted", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(startContainer("ctr", "img", {}));

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("--network");
  });

  it("passes --group-add flag when groups has one entry", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { groups: ["docker"] }),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    expect(runCall).toBeDefined();
    const runArgs = runCall![1] as string[];
    const idx = runArgs.indexOf("--group-add");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("docker");
  });

  it("passes multiple --group-add flags in order, stringifying numeric GIDs", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { groups: ["docker", 999] }),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const firstIdx = runArgs.indexOf("--group-add");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(runArgs[firstIdx + 1]).toBe("docker");
    const secondIdx = runArgs.indexOf("--group-add", firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(runArgs[secondIdx + 1]).toBe("999");
  });

  it("does not pass --group-add when groups is omitted", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(startContainer("ctr", "img", {}));

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("--group-add");
  });

  it("passes --device flag when devices has one entry", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { devices: ["/dev/kvm"] }),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    expect(runCall).toBeDefined();
    const runArgs = runCall![1] as string[];
    const idx = runArgs.indexOf("--device");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("/dev/kvm");
  });

  it("passes multiple --device flags in order", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer(
        "ctr",
        "img",
        {},
        {
          devices: ["/dev/kvm", "/dev/sda:/dev/xvda:rwm"],
        },
      ),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const firstIdx = runArgs.indexOf("--device");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(runArgs[firstIdx + 1]).toBe("/dev/kvm");
    const secondIdx = runArgs.indexOf("--device", firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(runArgs[secondIdx + 1]).toBe("/dev/sda:/dev/xvda:rwm");
  });

  it("does not pass --device when devices is omitted", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(startContainer("ctr", "img", {}));

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("--device");
  });

  it("passes --cpus flag when cpus is provided", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(startContainer("ctr", "img", {}, { cpus: 2 }));

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    expect(runCall).toBeDefined();
    const runArgs = runCall![1] as string[];
    const idx = runArgs.indexOf("--cpus");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("2");
  });

  it("stringifies fractional cpus values", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(startContainer("ctr", "img", {}, { cpus: 1.5 }));

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const idx = runArgs.indexOf("--cpus");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("1.5");
  });

  it("does not pass --cpus when cpus is omitted", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(startContainer("ctr", "img", {}));

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("--cpus");
  });

  type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;
  // execFile mock must return a ChildProcess; these tests never touch it.
  const execReturn = undefined as unknown as ChildProcess;

  it("passes --memory and --memory-swap when memory is provided", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as ExecCb)(null, "", "");
      return execReturn;
    });

    await Effect.runPromise(startContainer("ctr", "img", {}, { memory: "2g" }));

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    expect(runCall).toBeDefined();
    const runArgs = runCall![1] as string[];
    const memIdx = runArgs.indexOf("--memory");
    expect(memIdx).toBeGreaterThan(-1);
    expect(runArgs[memIdx + 1]).toBe("2g");
    const swapIdx = runArgs.indexOf("--memory-swap");
    expect(swapIdx).toBeGreaterThan(-1);
    expect(runArgs[swapIdx + 1]).toBe("2g");
  });

  it("passes --pids-limit when pidsLimit is provided", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as ExecCb)(null, "", "");
      return execReturn;
    });

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { pidsLimit: 256 }),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const idx = runArgs.indexOf("--pids-limit");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("256");
  });

  it("does not pass memory or pids flags when omitted", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as ExecCb)(null, "", "");
      return execReturn;
    });

    await Effect.runPromise(startContainer("ctr", "img", {}));

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("--memory");
    expect(runArgs).not.toContain("--memory-swap");
    expect(runArgs).not.toContain("--pids-limit");
  });

  it("uses -v format with formatVolumeMount for volume mounts", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer(
        "ctr",
        "img",
        {},
        {
          volumeMounts: [
            { hostPath: "/host/path", sandboxPath: "/sandbox/path" },
          ],
        },
      ),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain("-v");
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path:z");
  });

  it("includes readonly flag for read-only mounts", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer(
        "ctr",
        "img",
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

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path:ro,z");
  });

  it("default mount string ends with :z (SELinux shared label)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer(
        "ctr",
        "img",
        {},
        {
          volumeMounts: [
            { hostPath: "/host/path", sandboxPath: "/sandbox/path" },
          ],
        },
      ),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path:z");
  });

  it("selinuxLabel 'Z' produces :Z suffix", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer(
        "ctr",
        "img",
        {},
        {
          volumeMounts: [
            { hostPath: "/host/path", sandboxPath: "/sandbox/path" },
          ],
          selinuxLabel: "Z",
        },
      ),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path:Z");
  });

  it("selinuxLabel false produces no SELinux suffix", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer(
        "ctr",
        "img",
        {},
        {
          volumeMounts: [
            { hostPath: "/host/path", sandboxPath: "/sandbox/path" },
          ],
          selinuxLabel: false,
        },
      ),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path");
  });

  it("readonly with selinuxLabel false produces :ro only", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer(
        "ctr",
        "img",
        {},
        {
          volumeMounts: [
            {
              hostPath: "/host/path",
              sandboxPath: "/sandbox/path",
              readonly: true,
            },
          ],
          selinuxLabel: false,
        },
      ),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path:ro");
  });
});
