import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake @daytona/sdk modelling the default snapshot: the work dir is the
// `daytona` user's home, /home/daytona, whose parent (/home) it can't write.
//
// Commands run in a real local `sh`, with the semantics the Daytona API has
// (observed against a live sandbox, SDK 0.227.0):
// - `process.executeCommand` gives no stdin, and returns stdout and stderr
//   merged into `result`, with no separate stderr;
// - session commands give no stdin either, and stream stdout and stderr apart.
//   They run in the session's one long-lived shell, which records each
//   command's exit code after it. A command that ends that shell (a top-level
//   `exit`) never gets an exit code, and its log stream never closes.
// `fs.uploadFile(buffer, path)` writes the file where a command can read it.
const sdk = vi.hoisted(() => ({
  createParams: [] as unknown[],
  createdFolders: [] as string[],
  uploadedPaths: [] as string[],
}));

vi.mock("@daytona/sdk", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  // No stdin: the child reads EOF, as in a Daytona sandbox.
  const sh = (command: string, cwd?: string) =>
    spawnSync("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  // A session command, run as the session shell would: the shell records the
  // exit code (here, on fd 3) only if it is still alive after the command.
  const sessionSh = (command: string) => {
    const r = spawnSync("sh", ["-c", `${command}\nprintf %s "$?" >&3`], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    const recorded = r.output[3];
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: recorded ? Number(recorded) : undefined,
    };
  };
  const sessionCommands = new Map<string, ReturnType<typeof sessionSh>>();

  class Daytona {
    async create(params: unknown) {
      sdk.createParams.push(params);
      return {
        getWorkDir: async () => "/home/daytona",
        getUserHomeDir: async () => "/home/daytona",
        fs: {
          createFolder: async (path: string) => {
            sdk.createdFolders.push(path);
          },
          uploadFile: async (file: Buffer | string, remotePath: string) => {
            sdk.uploadedPaths.push(remotePath);
            if (Buffer.isBuffer(file)) writeFileSync(remotePath, file);
          },
        },
        process: {
          executeCommand: async (command: string, cwd?: string) => {
            const r = sh(`${command} 2>&1`, cwd);
            return { exitCode: r.status, result: r.stdout };
          },
          createSession: async () => {},
          deleteSession: async () => {},
          executeSessionCommand: async (
            _sessionId: string,
            req: { command: string },
          ) => {
            const cmdId = `cmd-${sessionCommands.size}`;
            sessionCommands.set(cmdId, sessionSh(req.command));
            return { cmdId };
          },
          getSessionCommandLogs: async (
            _sessionId: string,
            cmdId: string,
            onStdout: (chunk: string) => void,
            onStderr: (chunk: string) => void,
          ) => {
            const r = sessionCommands.get(cmdId)!;
            if (r.stdout) onStdout(r.stdout);
            if (r.stderr) onStderr(r.stderr);
            // The session shell died: the stream never closes.
            if (r.exitCode === undefined) await new Promise(() => {});
          },
          getSessionCommand: async (_sessionId: string, cmdId: string) => ({
            exitCode: sessionCommands.get(cmdId)!.exitCode,
          }),
        },
      };
    }
    async delete() {}
  }
  return { Daytona };
});

import { daytona } from "./daytona.js";

beforeEach(() => {
  sdk.createParams.length = 0;
  sdk.createdFolders.length = 0;
  sdk.uploadedPaths.length = 0;
});

describe("daytona()", () => {
  it("returns an isolated provider named 'daytona'", () => {
    const provider = daytona();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("daytona");
  });

  it("puts the worktree in a subdirectory of the work dir, so sync-in can replace it", async () => {
    // syncIn clones into `${worktreePath}_clone` and then replaces
    // worktreePath, so worktreePath's parent must be writable by the
    // sandbox user. On the default snapshot only the home dir is.
    const handle = await daytona().create({ env: {} });

    expect(handle.worktreePath).toBe("/home/daytona/workspace");
    expect(sdk.createdFolders).toContain("/home/daytona/workspace");
  });

  it("passes the resolved env to the sandbox as envVars", async () => {
    await daytona().create({ env: { CLAUDE_CODE_OAUTH_TOKEN: "t", FOO: "1" } });

    expect(sdk.createParams[0]).toMatchObject({
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: "t", FOO: "1" },
    });
  });

  it("keeps the user's create options and merges their envVars", async () => {
    await daytona({
      create: {
        ephemeral: true,
        labels: { a: "b" },
        envVars: { USER_VAR: "u", FOO: "from-create" },
      },
    }).create({ env: { FOO: "resolved", BAR: "2" } });

    expect(sdk.createParams[0]).toEqual({
      ephemeral: true,
      labels: { a: "b" },
      envVars: { USER_VAR: "u", FOO: "from-create", BAR: "2" },
    });
  });

  describe("exec", () => {
    const cwd = tmpdir();
    const prompt =
      "Create a file named a.txt\nwith 'quotes' and $HOME, verbatim";

    it("delivers stdin to the command", async () => {
      const handle = await daytona().create({ env: {} });

      const result = await handle.exec("cat", { cwd, stdin: prompt });

      expect(result).toMatchObject({ exitCode: 0, stdout: prompt });
    });

    it("delivers stdin to a streamed command", async () => {
      const handle = await daytona().create({ env: {} });
      const lines: string[] = [];

      const result = await handle.exec("cat", {
        cwd,
        stdin: prompt,
        onLine: (line) => lines.push(line),
      });

      expect(result.exitCode).toBe(0);
      expect(lines).toEqual(prompt.split("\n"));
    });

    it("removes the stdin file once the command has run", async () => {
      const handle = await daytona().create({ env: {} });

      await handle.exec("cat", { cwd, stdin: prompt });
      await handle.exec("cat", { cwd, stdin: prompt, onLine: () => {} });

      expect(sdk.uploadedPaths).toHaveLength(2);
      for (const path of sdk.uploadedPaths)
        expect(existsSync(path)).toBe(false);
    });

    it("returns a streamed command's exit code when it exits the shell", async () => {
      // A session runs commands in one long-lived shell. A top-level `exit`
      // must end the command, not that shell, or the call hangs forever.
      const handle = await daytona().create({ env: {} });
      const lines: string[] = [];

      const result = await handle.exec("echo before; exit 3", {
        cwd,
        onLine: (line) => lines.push(line),
      });

      expect(result.exitCode).toBe(3);
      expect(lines).toEqual(["before"]);
    });

    it("returns a streamed command's exit code when it exits the shell, with stdin", async () => {
      const handle = await daytona().create({ env: {} });

      const result = await handle.exec("cat; exit 3", {
        cwd,
        stdin: "hi",
        onLine: () => {},
      });

      expect(result).toMatchObject({ exitCode: 3, stdout: "hi" });
    });

    it("fails a streamed command whose session shell dies, instead of hanging", async () => {
      // Should the session shell die anyway (here, killed), no exit code is
      // ever recorded and the log stream never closes.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const handle = await daytona().create({ env: {} });

        const outcome = handle.exec("echo before; kill -9 $$", {
          cwd,
          onLine: () => {},
        });
        let settled = false;
        outcome.then(
          () => (settled = true),
          () => (settled = true),
        );
        for (let i = 0; i < 20 && !settled; i++)
          await vi.advanceTimersByTimeAsync(5000);

        await expect(outcome).rejects.toThrow(
          /session shell exited before the command finished/,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces a failed command's output as stderr", async () => {
      // Daytona merges stdout and stderr, so without this a failure reads
      // only "exit 128" with nothing to say why.
      const handle = await daytona().create({ env: {} });

      const result = await handle.exec(
        `git clone "/nonexistent/repo.bundle" "${cwd}/sandcastle-test-clone"`,
        { cwd },
      );

      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain("/nonexistent/repo.bundle");
    });
  });
});
