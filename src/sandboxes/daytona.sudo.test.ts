import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake @daytona/sdk that records the commands sent to the sandbox.
const sdk = vi.hoisted(() => ({ commands: [] as string[] }));

vi.mock("@daytona/sdk", () => {
  class Daytona {
    async create() {
      return {
        getWorkDir: async () => "/home/daytona",
        getUserHomeDir: async () => "/home/daytona",
        fs: {
          createFolder: async () => {},
        },
        process: {
          executeCommand: async (command: string) => {
            sdk.commands.push(command);
            return { exitCode: 0, result: "" };
          },
          createSession: async () => {},
          deleteSession: async () => {},
          executeSessionCommand: async (
            _sessionId: string,
            req: { command: string },
          ) => {
            sdk.commands.push(req.command);
            return { cmdId: "cmd-1" };
          },
          getSessionCommandLogs: async () => {},
          getSessionCommand: async () => ({ exitCode: 0 }),
        },
        delete: async () => {},
      };
    }
  }
  return { Daytona };
});

import { daytona } from "./daytona.js";

beforeEach(() => {
  sdk.commands.length = 0;
});

describe("daytona() exec with sudo", () => {
  // `sudo` would need a sudo binary on the test host, so stand in a fake one
  // that runs its arguments as given: this checks which part of the command
  // lands inside sudo's argv.
  const runWithFakeSudo = (command: string) => {
    const dir = mkdtempSync(join(tmpdir(), "daytona-sudo-"));
    try {
      const sudo = join(dir, "sudo");
      const out = join(dir, "out");
      spawnSync("sh", [
        "-c",
        `printf '#!/bin/sh\\necho "$*" >> ${out}\\n' > ${sudo} && chmod +x ${sudo}`,
      ]);
      spawnSync("sh", ["-c", command], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      return readFileSync(out, "utf8").trim().split("\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("elevates the whole compound command, not just its first part", async () => {
    const handle = await daytona().create({ env: {} } as any);

    await handle.exec("echo a > /dev/null && echo b > /dev/null", {
      sudo: true,
    });

    // sudo is invoked once, with the whole compound command as its argument.
    expect(runWithFakeSudo(sdk.commands.at(-1)!)).toEqual([
      "sh -c echo a > /dev/null && echo b > /dev/null",
    ]);
  });

  it("elevates the whole compound command when streaming", async () => {
    const handle = await daytona().create({ env: {} } as any);

    await handle.exec("a; b", { sudo: true, onLine: () => {} });

    // The session command is followed by pid-file housekeeping, so look for
    // it among everything sent rather than at the end.
    expect(sdk.commands).toContainEqual(
      expect.stringContaining(`sudo sh -c 'a; b'`),
    );
  });
});
