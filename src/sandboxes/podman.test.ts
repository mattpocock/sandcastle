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
import { podman } from "./podman.js";

// What's left of the podman() unit tests. Everything else moved to real
// containers in tests/local/ (`npm run test:local`) and to
// tests/containerProviderOptions.test.ts. This case stays: podman() checks
// for a running Podman Machine only on macOS and Windows, and the
// "machine list answered, none running" path needs Podman installed there,
// which neither CI nor the local suite's Linux hosts have.

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
});

describe("podman()", () => {
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
});
