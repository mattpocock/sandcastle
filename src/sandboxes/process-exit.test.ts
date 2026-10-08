import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BindMountSandboxHandle } from "../SandboxProvider.js";
import { docker } from "./docker.js";
import { podman } from "./podman.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((...args: unknown[]) => {
      const commandArgs = args[1] as string[];
      const callback = args.at(-1) as (
        error: null,
        stdout: string,
        stderr: string,
      ) => void;
      callback(
        null,
        commandArgs[0] === "machine" ? '[{"Running":true}]' : "",
        "",
      );
      return new actual.ChildProcess();
    }),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

describe.each([
  { name: "docker", factory: docker },
  { name: "podman", factory: podman },
])("$name process exits", ({ name, factory }) => {
  let handle: BindMountSandboxHandle;
  let proc: ChildProcess;
  let stdin: PassThrough;
  let stdout: PassThrough;
  let stderr: PassThrough;

  beforeEach(async () => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    proc = Object.assign(new ChildProcess(), { stdin, stdout, stderr });
    vi.mocked(spawn).mockReturnValue(proc);
    handle = (await factory({ imageName: "test-image" }).create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [],
      env: {},
    })) as BindMountSandboxHandle;
  });

  afterEach(async () => {
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
    await handle.close();
    vi.clearAllMocks();
  });

  describe.each(["buffered", "streaming", "interactive"] as const)(
    "%s execution",
    (mode) => {
      const execute = (onLine: (line: string) => void) =>
        mode === "interactive"
          ? handle.interactiveExec!(["sh"], { stdin, stdout, stderr })
          : handle.exec("test command", {
              ...(mode === "streaming" ? { onLine } : {}),
            });

      it.each([
        { code: null, signal: "SIGTERM", expected: 1 },
        { code: null, signal: "SIGKILL", expected: 1 },
        { code: 0, signal: null, expected: 0 },
        { code: 42, signal: null, expected: 42 },
      ])(
        "returns $expected after close($code, $signal)",
        async ({ code, signal, expected }) => {
          const onLine = vi.fn();
          const result = execute(onLine);
          stdout.end("partial output\n");
          stderr.end("diagnostic\n");
          proc.emit("close", code, signal);

          const completed = await result;
          expect(completed.exitCode).toBe(expected);
          expect(spawn).toHaveBeenCalledWith(
            name,
            expect.arrayContaining(["exec"]),
            expect.any(Object),
          );
          if (mode !== "interactive") {
            expect(completed).toMatchObject({
              stdout:
                mode === "streaming" ? "partial output" : "partial output\n",
              stderr: "diagnostic\n",
            });
          }
          if (mode === "streaming") {
            expect(onLine).toHaveBeenCalledWith("partial output");
          }
        },
      );

      it("still rejects spawn errors", async () => {
        const result = expect(execute(vi.fn())).rejects.toThrow(
          `${name} exec failed: spawn failed`,
        );
        proc.emit("error", new Error("spawn failed"));
        await result;
      });
    },
  );
});
