/**
 * Shared helper for filesystem-backed test sandbox providers.
 *
 * Implements "run commands in a temp directory" — process spawning,
 * working-directory management, exit code propagation, cleanup. Both
 * `testBindMount` and `testIsolated` are thin adaptors over this helper.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type ExecResult,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";

export interface TempSandbox {
  readonly worktreePath: string;
  readonly exec: (
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
    },
  ) => Promise<ExecResult>;
  readonly close: () => Promise<void>;
}

export const createTempSandbox = async (
  prefix: string,
): Promise<TempSandbox> => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), prefix));
  const worktreePath = join(sandboxRoot, "workspace");
  await mkdir(worktreePath, { recursive: true });
  const realWorktreePath = await realpath(worktreePath);

  const exec = (
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
    },
  ): Promise<ExecResult> => {
    if (options?.onLine) {
      const onLine = options.onLine;
      return new Promise((resolve, reject) => {
        const proc = spawn("sh", ["-c", command], {
          cwd: options?.cwd ?? worktreePath,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const stdoutTail = new BoundedTail(MAX_TAIL_CHARS, "\n");
        const stderrTail = new BoundedTail(MAX_TAIL_CHARS, "");

        const rl = createInterface({ input: proc.stdout! });
        rl.on("line", (line) => {
          stdoutTail.push(line);
          onLine(line);
        });

        proc.stderr!.on("data", (chunk: Buffer) => {
          stderrTail.push(chunk.toString());
        });

        proc.on("error", (error) => {
          reject(new Error(`exec failed: ${error.message}`));
        });

        proc.on("close", (code) => {
          resolve({
            stdout: stdoutTail.toString(),
            stderr: stderrTail.toString(),
            exitCode: code ?? 0,
          });
        });
      });
    }

    return new Promise((resolve, reject) => {
      execFile(
        "sh",
        ["-c", command],
        {
          cwd: options?.cwd ?? worktreePath,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error && error.code === undefined) {
            reject(new Error(`exec failed: ${error.message}`));
          } else {
            resolve({
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              exitCode: typeof error?.code === "number" ? error.code : 0,
            });
          }
        },
      );
    });
  };

  return {
    worktreePath: realWorktreePath,
    exec,
    close: () => rm(sandboxRoot, { recursive: true, force: true }),
  };
};

export interface StubProviderRecord {
  readonly provider: BindMountSandboxProvider;
  readonly createCalls: ReadonlyArray<unknown>;
  readonly closeCalls: { count: number };
}

/**
 * Create a no-op bind-mount sandbox provider that records `create`/`close` calls.
 * For tests that verify call contracts without exercising filesystem behaviour.
 */
export const testStubProvider = (
  options: { name?: string; worktreePath?: string } = {},
): StubProviderRecord => {
  const createCalls: unknown[] = [];
  const closeCalls = { count: 0 };
  const provider = createBindMountSandboxProvider({
    name: options.name ?? "test-stub",
    create: async (createOptions) => {
      createCalls.push(createOptions);
      const handle: BindMountSandboxHandle = {
        worktreePath: options.worktreePath ?? "/home/agent/workspace",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {
          closeCalls.count++;
        },
      };
      return handle;
    },
  });
  return { provider, createCalls, closeCalls };
};
