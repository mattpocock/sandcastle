import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type * as ChildProcessModule from "node:child_process";
import { ChildProcess, execFile } from "node:child_process";
import { buildImage, removeImage } from "./PodmanLifecycle.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    execFile: vi.fn<typeof actual.execFile>(),
    execFileSync: vi.fn<typeof actual.execFileSync>(),
  };
});

const mockExecFile = vi.mocked(execFile);

/** Makes the mocked execFile call back with the given outcome. */
const respondWith = (error: Error | null, stdout: string, stderr: string) => {
  mockExecFile.mockImplementation((...args) => {
    // The callback is execFile's fourth argument.
    args[3]?.(error, stdout, stderr);
    return new ChildProcess();
  });
};

describe("PodmanLifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });
  describe("buildImage", () => {
    it("calls podman build with image name and directory", async () => {
      respondWith(null, "", "");

      await Effect.runPromise(buildImage("my-image", "/path/to/dir"));

      expect(mockExecFile).toHaveBeenCalledWith(
        "podman",
        expect.arrayContaining(["build", "-t", "my-image"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("uses -f flag when containerfile option is provided", async () => {
      respondWith(null, "", "");

      await Effect.runPromise(
        buildImage("my-image", "/path/to/dir", {
          containerfile: "/custom/Containerfile",
        }),
      );

      const [call] = mockExecFile.mock.calls;
      assert.isDefined(call);
      const [, args] = call;
      assert.exists(args);
      expect(args).toContain("-f");
      expect(args).toContain("build");
      expect(args).toContain("-t");
      expect(args).toContain("my-image");
    });

    it("fails with PodmanError when podman build fails", async () => {
      respondWith(new Error("build failed"), "", "error: no such file");

      const result = await Effect.runPromiseExit(
        buildImage("my-image", "/path/to/dir"),
      );

      expect(result._tag).toBe("Failure");
    });
  });

  describe("removeImage", () => {
    it("calls podman rmi with image name", async () => {
      respondWith(null, "", "");

      await Effect.runPromise(removeImage("my-image"));

      expect(mockExecFile).toHaveBeenCalledWith(
        "podman",
        ["rmi", "my-image"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("fails with PodmanError when podman rmi fails", async () => {
      respondWith(new Error("rmi failed"), "", "image not found");

      const result = await Effect.runPromiseExit(removeImage("my-image"));

      expect(result._tag).toBe("Failure");
    });

    it("fails with ImageNotFoundError, not PodmanError, when the image does not exist", async () => {
      respondWith(
        new Error("Command failed"),
        "",
        "Error: sandcastle:nope: image not known\n",
      );

      const error = await Effect.runPromise(
        Effect.flip(removeImage("sandcastle:nope")),
      );

      expect(error._tag).toBe("ImageNotFoundError");
      expect(error.message).toBe(
        "Podman image 'sandcastle:nope' does not exist, so there is nothing to remove.",
      );
    });
  });
});
