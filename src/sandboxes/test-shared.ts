/**
 * Shared helper for filesystem-backed test sandbox providers.
 *
 * Implements "run commands in a temp directory" — process spawning,
 * working-directory management, exit code propagation, cleanup. Both
 * `testBindMount` and `testIsolated` are thin adaptors over this helper.
 */

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createBindMountSandboxProvider } from "../SandboxProvider.js";
import type {
  BindMountSandboxHandle,
  BindMountSandboxProvider,
  ExecResult,
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

type ExecOptions = NonNullable<Parameters<TempSandbox["exec"]>[1]>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Run `command`, streaming stdout lines to `onLine`; keeps a bounded tail. */
const streamExec = async (
  command: string,
  cwd: string,
  onLine: (line: string) => void,
): Promise<ExecResult> => {
  const proc = spawn("sh", ["-c", command], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutTail = new BoundedTail(MAX_TAIL_CHARS, "\n");
  const stderrTail = new BoundedTail(MAX_TAIL_CHARS, "");

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    stdoutTail.push(line);
    onLine(line);
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    stderrTail.push(chunk.toString());
  });

  // `once` rejects if the process emits "error" (e.g. spawn failure) first.
  const closeArgs: unknown[] = await once(proc, "close").catch(
    (error: unknown) => {
      throw new Error(`exec failed: ${errorMessage(error)}`, { cause: error });
    },
  );
  const [code] = closeArgs;
  return {
    stdout: stdoutTail.toString(),
    stderr: stderrTail.toString(),
    exitCode: typeof code === "number" ? code : 0,
  };
};

/** Run `command` to completion and return its whole output. */
const bufferedExec = (command: string, cwd: string): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    execFile(
      "sh",
      ["-c", command],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && error.code === undefined) {
          reject(new Error(`exec failed: ${error.message}`));
        } else {
          resolve({
            stdout,
            stderr,
            exitCode: typeof error?.code === "number" ? error.code : 0,
          });
        }
      },
    );
  });

export const createTempSandbox = async (
  prefix: string,
): Promise<TempSandbox> => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), prefix));
  const worktreePath = join(sandboxRoot, "workspace");
  await mkdir(worktreePath, { recursive: true });

  const exec = async (
    command: string,
    options?: ExecOptions,
  ): Promise<ExecResult> => {
    const cwd = options?.cwd ?? worktreePath;
    return options?.onLine
      ? streamExec(command, cwd, options.onLine)
      : bufferedExec(command, cwd);
  };

  return {
    worktreePath,
    exec,
    close: async () => rm(sandboxRoot, { recursive: true, force: true }),
  };
};

export interface StubProviderRecord {
  readonly provider: BindMountSandboxProvider;
  readonly createCalls: readonly unknown[];
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
        copyFileIn: () => Promise.resolve(),
        copyFileOut: () => Promise.resolve(),
        close: async () => {
          closeCalls.count++;
        },
      };
      return handle;
    },
  });
  return { provider, createCalls, closeCalls };
};
