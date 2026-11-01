import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn<typeof actual.execFile>(),
    execFileSync: vi.fn<typeof actual.execFileSync>(),
  };
});

import { ChildProcess, execFile } from "node:child_process";
import { startContainer, buildImage, removeImage } from "./DockerLifecycle.js";

const mockExecFile = vi.mocked(execFile);

/** Makes every docker call call back with `error` and `stderr` (and no stdout). */
const dockerCallsBack = (error: Error | null, stderr: string) => {
  mockExecFile.mockImplementation((...execFileArgs) => {
    // execFile(file, args, options, callback)
    const { 3: callback } = execFileArgs;
    callback?.(error, "", stderr);
    return new ChildProcess();
  });
};

/** The argument list of the first recorded `docker <subcommand>` call, failing the test if there was none. */
const dockerArgsFor = (subcommand: string): readonly string[] => {
  const call = mockExecFile.mock.calls.find(
    ([, args]) => Array.isArray(args) && args[0] === subcommand,
  );
  assert.isDefined(call, `expected a docker ${subcommand} call`);
  const [, args] = call;
  assert.exists(args);
  return args;
};

afterEach(() => {
  mockExecFile.mockReset();
});

describe("buildImage", () => {
  it("passes --build-arg flags when buildArgs is provided", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(
      buildImage("my-image", "/tmp/dir", {
        buildArgs: { AGENT_UID: "1001", AGENT_GID: "1001" },
      }),
    );

    const buildArgs = dockerArgsFor("build");
    const uidIdx = buildArgs.indexOf("--build-arg");
    expect(uidIdx).toBeGreaterThan(-1);
    expect(buildArgs[uidIdx + 1]).toBe("AGENT_UID=1001");
    const gidIdx = buildArgs.indexOf("--build-arg", uidIdx + 1);
    expect(gidIdx).toBeGreaterThan(-1);
    expect(buildArgs[gidIdx + 1]).toBe("AGENT_GID=1001");
  });

  it("does not pass --build-arg flags when buildArgs is omitted", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(buildImage("my-image", "/tmp/dir"));

    const buildArgs = dockerArgsFor("build");
    expect(buildArgs).not.toContain("--build-arg");
  });
});

describe("startContainer", () => {
  it("passes --network flag when network is a string", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { network: "my-network" }),
    );

    const runArgs = dockerArgsFor("run");
    const networkIdx = runArgs.indexOf("--network");
    expect(networkIdx).toBeGreaterThan(-1);
    expect(runArgs[networkIdx + 1]).toBe("my-network");
  });

  it("passes multiple --network flags when network is an array", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { network: ["net1", "net2"] }),
    );

    const runArgs = dockerArgsFor("run");
    const firstIdx = runArgs.indexOf("--network");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(runArgs[firstIdx + 1]).toBe("net1");
    const secondIdx = runArgs.indexOf("--network", firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(runArgs[secondIdx + 1]).toBe("net2");
  });

  it("does not pass --network when network is omitted", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(startContainer("ctr", "img", {}));

    const runArgs = dockerArgsFor("run");
    expect(runArgs).not.toContain("--network");
  });

  it("passes --group-add flag when groups has one entry", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { groups: ["docker"] }),
    );

    const runArgs = dockerArgsFor("run");
    const idx = runArgs.indexOf("--group-add");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("docker");
  });

  it("passes multiple --group-add flags in order, stringifying numeric GIDs", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { groups: ["docker", 999] }),
    );

    const runArgs = dockerArgsFor("run");
    const firstIdx = runArgs.indexOf("--group-add");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(runArgs[firstIdx + 1]).toBe("docker");
    const secondIdx = runArgs.indexOf("--group-add", firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(runArgs[secondIdx + 1]).toBe("999");
  });

  it("does not pass --group-add when groups is omitted", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(startContainer("ctr", "img", {}));

    const runArgs = dockerArgsFor("run");
    expect(runArgs).not.toContain("--group-add");
  });

  it("passes --device flag when devices has one entry", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { devices: ["/dev/kvm"] }),
    );

    const runArgs = dockerArgsFor("run");
    const idx = runArgs.indexOf("--device");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("/dev/kvm");
  });

  it("passes multiple --device flags in order", async () => {
    dockerCallsBack(null, "");

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

    const runArgs = dockerArgsFor("run");
    const firstIdx = runArgs.indexOf("--device");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(runArgs[firstIdx + 1]).toBe("/dev/kvm");
    const secondIdx = runArgs.indexOf("--device", firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(runArgs[secondIdx + 1]).toBe("/dev/sda:/dev/xvda:rwm");
  });

  it("does not pass --device when devices is omitted", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(startContainer("ctr", "img", {}));

    const runArgs = dockerArgsFor("run");
    expect(runArgs).not.toContain("--device");
  });

  it("passes --cpus flag when cpus is provided", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(startContainer("ctr", "img", {}, { cpus: 2 }));

    const runArgs = dockerArgsFor("run");
    const idx = runArgs.indexOf("--cpus");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("2");
  });

  it("stringifies fractional cpus values", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(startContainer("ctr", "img", {}, { cpus: 1.5 }));

    const runArgs = dockerArgsFor("run");
    const idx = runArgs.indexOf("--cpus");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("1.5");
  });

  it("does not pass --cpus when cpus is omitted", async () => {
    dockerCallsBack(null, "");

    await Effect.runPromise(startContainer("ctr", "img", {}));

    const runArgs = dockerArgsFor("run");
    expect(runArgs).not.toContain("--cpus");
  });

  it("uses -v format with formatVolumeMount for volume mounts", async () => {
    dockerCallsBack(null, "");

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

    const runArgs = dockerArgsFor("run");
    expect(runArgs).toContain("-v");
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path:z");
  });

  it("includes readonly flag for read-only mounts", async () => {
    dockerCallsBack(null, "");

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

    const runArgs = dockerArgsFor("run");
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path:ro,z");
  });

  it("default mount string ends with :z (SELinux shared label)", async () => {
    dockerCallsBack(null, "");

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

    const runArgs = dockerArgsFor("run");
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path:z");
  });

  it("selinuxLabel 'Z' produces :Z suffix", async () => {
    dockerCallsBack(null, "");

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

    const runArgs = dockerArgsFor("run");
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path:Z");
  });

  it("selinuxLabel false produces no SELinux suffix", async () => {
    dockerCallsBack(null, "");

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

    const runArgs = dockerArgsFor("run");
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path");
  });

  it("readonly with selinuxLabel false produces :ro only", async () => {
    dockerCallsBack(null, "");

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

    const runArgs = dockerArgsFor("run");
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/host/path:/sandbox/path:ro");
  });
});

describe("removeImage", () => {
  it("fails with ImageNotFoundError, not DockerError, when the image does not exist", async () => {
    dockerCallsBack(
      new Error("Command failed"),
      "Error response from daemon: No such image: sandcastle:nope\n",
    );

    const error = await Effect.runPromise(
      Effect.flip(removeImage("sandcastle:nope")),
    );

    expect(error._tag).toBe("ImageNotFoundError");
    expect(error.message).toBe(
      "Docker image 'sandcastle:nope' does not exist, so there is nothing to remove.",
    );
  });

  it("keeps other rmi failures as DockerError", async () => {
    dockerCallsBack(
      new Error("Command failed"),
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n",
    );

    const error = await Effect.runPromise(
      Effect.flip(removeImage("sandcastle:x")),
    );

    expect(error._tag).toBe("DockerError");
  });
});
