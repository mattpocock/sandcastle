import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execFile } from "node:child_process";
import { buildImage, removeImage } from "./PodmanLifecycle.js";

const mockExecFile = vi.mocked(execFile);

describe("PodmanLifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });
  describe("buildImage", () => {
    it("calls podman build with image name and directory", async () => {
      mockExecFile.mockImplementation((_cmd, args, _opts, cb: any) => {
        cb(null, "", "");
        return undefined as any;
      });

      await Effect.runPromise(buildImage("my-image", "/path/to/dir"));

      expect(mockExecFile).toHaveBeenCalledWith(
        "podman",
        expect.arrayContaining(["build", "-t", "my-image"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("uses -f flag when containerfile option is provided", async () => {
      mockExecFile.mockImplementation((_cmd, args, _opts, cb: any) => {
        cb(null, "", "");
        return undefined as any;
      });

      await Effect.runPromise(
        buildImage("my-image", "/path/to/dir", {
          containerfile: "/custom/Containerfile",
        }),
      );

      const args = mockExecFile.mock.calls[0]![1] as string[];
      expect(args).toContain("-f");
      expect(args).toContain("build");
      expect(args).toContain("-t");
      expect(args).toContain("my-image");
    });

    it("fails with PodmanError when podman build fails", async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
        const err = new Error("build failed");
        cb(err, "", "error: no such file");
        return undefined as any;
      });

      const result = await Effect.runPromiseExit(
        buildImage("my-image", "/path/to/dir"),
      );

      expect(result._tag).toBe("Failure");
    });
  });

  describe("removeImage", () => {
    it("calls podman rmi with image name", async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(null, "", "");
        return undefined as any;
      });

      await Effect.runPromise(removeImage("my-image"));

      expect(mockExecFile).toHaveBeenCalledWith(
        "podman",
        ["rmi", "my-image"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("fails with PodmanError when podman rmi fails", async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
        const err = new Error("rmi failed");
        cb(err, "", "image not found");
        return undefined as any;
      });

      const result = await Effect.runPromiseExit(removeImage("my-image"));

      expect(result._tag).toBe("Failure");
    });

    it("fails with ImageNotFoundError, not PodmanError, when the image does not exist", async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(
          new Error("Command failed"),
          "",
          "Error: sandcastle:nope: image not known\n",
        );
        return undefined as any;
      });

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
