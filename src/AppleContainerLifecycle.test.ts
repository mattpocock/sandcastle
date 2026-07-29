import { execFile } from "node:child_process";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildImage, removeImage } from "./AppleContainerLifecycle.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
});

describe("AppleContainerLifecycle", () => {
  it("builds a Dockerfile with host identity build arguments", async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback!(null, "", "");
      return undefined as never;
    });

    await Effect.runPromise(
      buildImage("sandcastle:test", "/repo/.sandcastle", {
        buildArgs: { AGENT_UID: "501", AGENT_GID: "20" },
      }),
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      "container",
      [
        "build",
        "-t",
        "sandcastle:test",
        "--build-arg",
        "AGENT_UID=501",
        "--build-arg",
        "AGENT_GID=20",
        "/repo/.sandcastle",
      ],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("uses the working directory as context for a custom Dockerfile", async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback!(null, "", "");
      return undefined as never;
    });

    await Effect.runPromise(
      buildImage("sandcastle:test", "/repo/.sandcastle", {
        dockerfile: "/repo/docker/Agent.Dockerfile",
      }),
    );

    const args = mockExecFile.mock.calls[0]![1] as string[];
    expect(args).toEqual([
      "build",
      "-t",
      "sandcastle:test",
      "-f",
      "/repo/docker/Agent.Dockerfile",
      process.cwd(),
    ]);
  });

  it("surfaces build failures as AppleContainerError", async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback!(new Error("build failed"), "", "builder unavailable");
      return undefined as never;
    });

    const result = await Effect.runPromiseExit(
      buildImage("sandcastle:test", "/repo/.sandcastle"),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("AppleContainerError");
      expect(String(result.cause)).toContain("builder unavailable");
    }
  });

  it("removes an image through the native image command", async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback!(null, "", "");
      return undefined as never;
    });

    await Effect.runPromise(removeImage("sandcastle:test"));

    expect(mockExecFile).toHaveBeenCalledWith(
      "container",
      ["image", "delete", "sandcastle:test"],
      expect.any(Object),
      expect.any(Function),
    );
  });
});
