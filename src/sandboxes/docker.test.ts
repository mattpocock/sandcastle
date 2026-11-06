import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );

  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { execFile } from "node:child_process";
import { docker } from "./docker.js";

// docker() checks the image with `docker image inspect` before it starts a
// container. These cases pin how that check reports each kind of failure,
// which needs a daemon that is down or misbehaving: not something CI or the
// local suite can arrange on demand.

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
});

/** Make the next `docker image inspect` fail with exit code 1 and `stderr`. */
const inspectFailsWith = (stderr: string) => {
  mockExecFile.mockImplementationOnce((_command, _args, callback: any) => {
    const error = Object.assign(new Error("Command failed: docker image"), {
      code: 1,
    });
    callback(error, "", stderr);
    return undefined as any;
  });
};

const createSandbox = () =>
  docker({ imageName: "sandcastle:test" }).create({
    worktreePath: "/tmp/worktree",
    hostRepoPath: "/tmp/repo",
    mounts: [
      { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
    ],
    env: {},
  });

describe("docker() image check", () => {
  it("says the image is missing when docker reports no such image", async () => {
    inspectFailsWith(
      "Error response from daemon: No such image: sandcastle:test\n",
    );

    await expect(createSandbox()).rejects.toThrow(
      "Image 'sandcastle:test' not found locally. Build it first with 'sandcastle docker build-image'.",
    );
  });

  it("says the Docker engine is not reachable when the daemon socket is down", async () => {
    const stderr =
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
    inspectFailsWith(`${stderr}\n`);

    const result = createSandbox();
    await expect(result).rejects.toThrow("Docker engine is not reachable");
    await expect(result).rejects.toThrow(stderr);
    await expect(result).rejects.not.toThrow("not found locally");
  });

  it("says the Docker engine is not reachable when the Windows named pipe is missing", async () => {
    const stderr =
      'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/images/sandcastle:test/json": ' +
      "open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.";
    inspectFailsWith(`${stderr}\n`);

    const result = createSandbox();
    await expect(result).rejects.toThrow("Docker engine is not reachable");
    await expect(result).rejects.toThrow(stderr);
    await expect(result).rejects.not.toThrow("not found locally");
  });

  it("surfaces docker's stderr for any other failure", async () => {
    const stderr =
      "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: " +
      "dial unix /var/run/docker.sock: connect: permission denied";
    inspectFailsWith(`${stderr}\n`);

    const result = createSandbox();
    await expect(result).rejects.toThrow(stderr);
    await expect(result).rejects.not.toThrow("not found locally");
  });
});
