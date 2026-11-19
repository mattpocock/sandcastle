import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BindMountSandboxHandle, ExecResult } from "@ai-hero/sandcastle";
import { opencode } from "@ai-hero/sandcastle";

// OpenCode V2 moved session interchange under `opencode session export` /
// `opencode session import` (and needs `--standalone` under bwrap), while V1
// keeps the top-level `export` / `import`. The provider probes the installed
// CLI's major version once per sandbox handle and picks the matching commands.

const SESSION_ID = "ses_version_probe";
const HOST_CWD = "/host/repo";
const SANDBOX_CWD = "/work/repo";
const SANDBOX_EXPORT_DIR = "/work/tmp";

/** A bind-mount handle that records commands and answers the version probe. */
const recordingHandle = (
  version: ExecResult,
): { handle: BindMountSandboxHandle; commands: string[] } => {
  const commands: string[] = [];
  const handle: BindMountSandboxHandle = {
    worktreePath: SANDBOX_CWD,
    exec: async (command) => {
      commands.push(command);
      if (command === "opencode --version") {
        return version;
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    copyFileIn: async () => undefined,
    copyFileOut: async () => undefined,
    close: async () => undefined,
  };
  return { handle, commands };
};

describe("opencode session interchange command selection", () => {
  let hostDir = "";

  beforeEach(() => {
    hostDir = mkdtempSync(path.join(tmpdir(), "opencode-version-"));
  });

  afterEach(() => {
    rmSync(hostDir, { recursive: true, force: true });
  });

  const storage = () =>
    opencode("opencode/big-pickle", {
      sessionStorage: {
        hostSessionsDir: hostDir,
        sandboxExportDir: SANDBOX_EXPORT_DIR,
      },
    }).sessionStorage;

  const roundTrip = async (handle: BindMountSandboxHandle): Promise<void> => {
    const sessionStorage = storage();
    const transfer = {
      hostCwd: HOST_CWD,
      sandboxCwd: SANDBOX_CWD,
      sessionId: SESSION_ID,
      handle,
    };
    await sessionStorage.captureToHost(transfer);
    await sessionStorage.resumeIntoSandbox(transfer);
  };

  it("uses `opencode session export/import --standalone` on OpenCode v2", async () => {
    const { handle, commands } = recordingHandle({
      stdout: "2.3.0",
      stderr: "",
      exitCode: 0,
    });

    await roundTrip(handle);

    expect(commands).toContain(
      `opencode session export '${SESSION_ID}' --standalone > '${SANDBOX_EXPORT_DIR}/${SESSION_ID}.json'`,
    );
    expect(commands).toContain(
      `opencode session import '${SANDBOX_EXPORT_DIR}/${SESSION_ID}.json' --standalone`,
    );
  });

  it("uses the top-level export/import commands on OpenCode v1", async () => {
    const { handle, commands } = recordingHandle({
      stdout: "1.19.6",
      stderr: "",
      exitCode: 0,
    });

    await roundTrip(handle);

    expect(commands).toContain(
      `opencode export '${SESSION_ID}' > '${SANDBOX_EXPORT_DIR}/${SESSION_ID}.json'`,
    );
    expect(commands).toContain(
      `opencode import '${SANDBOX_EXPORT_DIR}/${SESSION_ID}.json'`,
    );
  });

  it("falls back to the top-level commands when the version probe fails", async () => {
    const { handle, commands } = recordingHandle({
      stdout: "",
      stderr: "opencode: command not found",
      exitCode: 127,
    });

    await roundTrip(handle);

    expect(commands).toContain(
      `opencode export '${SESSION_ID}' > '${SANDBOX_EXPORT_DIR}/${SESSION_ID}.json'`,
    );
    expect(commands).toContain(
      `opencode import '${SANDBOX_EXPORT_DIR}/${SESSION_ID}.json'`,
    );
  });

  it("probes the CLI version once per sandbox across capture and resume", async () => {
    const { handle, commands } = recordingHandle({
      stdout: "2.3.0",
      stderr: "",
      exitCode: 0,
    });

    await roundTrip(handle);

    expect(
      commands.filter((command) => command === "opencode --version"),
    ).toHaveLength(1);
  });
});
