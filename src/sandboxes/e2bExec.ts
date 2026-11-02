/**
 * The `exec` of the E2B sandbox provider (`./e2b.ts`): native stdin, live
 * line streaming, and a non-zero exit mapped to its result.
 */

import type { CommandExitError, CommandHandle, Sandbox } from "e2b";
import type { ExecResult, IsolatedSandboxHandle } from "../SandboxProvider.js";
import { BoundedTail } from "../boundedTail.js";

/** The SDK's non-zero-exit error class, loaded with the SDK at runtime. */
type ExitErrorClass = typeof CommandExitError;
type ExecOptions = Parameters<IsolatedSandboxHandle["exec"]>[1];

/** Send stdin, then close it. The command may exit before reading it. */
const deliverStdin = async (
  handle: CommandHandle,
  stdin: string,
): Promise<void> => {
  try {
    if (stdin !== "") {
      await handle.sendStdin(stdin);
    }
    await handle.closeStdin();
  } catch (error) {
    // A command that already exited is a NotFoundError; wait() still reports it.
    if (!(error instanceof Error && error.name === "NotFoundError")) {
      await handle.kill().catch(() => undefined);
      throw error;
    }
  }
};

const isExitError = (
  ExitError: ExitErrorClass,
  error: unknown,
): error is CommandExitError => error instanceof ExitError;

/** Wait for a command, mapping a non-zero exit to its result. */
const waitForExit = async (
  ExitError: ExitErrorClass,
  handle: CommandHandle,
): Promise<ExecResult> => {
  try {
    const { stdout, stderr, exitCode } = await handle.wait();
    return { stdout, stderr, exitCode };
  } catch (error) {
    if (!isExitError(ExitError, error)) {
      throw error;
    }
    const { stdout, stderr, exitCode } = error;
    return { stdout, stderr, exitCode };
  }
};

/** Split streamed stdout into lines for `onLine`, keeping bounded tails. */
const lineStreams = (onLine: (line: string) => void, maxTail: number) => {
  const stdoutTail = new BoundedTail(maxTail, "\n");
  const stderrTail = new BoundedTail(maxTail, "");
  let partial = "";
  return {
    onStdout: (chunk: string): void => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        stdoutTail.push(line);
        onLine(line);
      }
    },
    onStderr: (chunk: string): void => {
      stderrTail.push(chunk);
    },
    finish: (exitCode: number): ExecResult => {
      if (partial !== "") {
        stdoutTail.push(partial);
        onLine(partial);
        partial = "";
      }
      return {
        stdout: stdoutTail.toString(),
        stderr: stderrTail.toString(),
        exitCode,
      };
    },
  };
};

/** What `exec` needs from the provider. */
export interface ExecContext {
  readonly ExitError: ExitErrorClass;
  readonly sandbox: Sandbox;
  readonly worktreePath: string;
  readonly maxTail: number;
}

/** The handle's `exec`, bound to one sandbox and its worktree. */
export const makeExec =
  ({ ExitError, sandbox, worktreePath, maxTail }: ExecContext) =>
  async (command: string, opts?: ExecOptions): Promise<ExecResult> => {
    const streams =
      opts?.onLine === undefined
        ? undefined
        : lineStreams(opts.onLine, maxTail);
    const handle = await sandbox.commands.run(command, {
      background: true,
      cwd: opts?.cwd ?? worktreePath,
      ...(opts?.sudo === true ? { user: "root" } : {}),
      stdin: opts?.stdin !== undefined,
      timeoutMs: 0,
      ...(streams === undefined
        ? {}
        : { onStdout: streams.onStdout, onStderr: streams.onStderr }),
    });
    if (opts?.stdin !== undefined) {
      await deliverStdin(handle, opts.stdin);
    }
    const result = await waitForExit(ExitError, handle);
    return streams === undefined ? result : streams.finish(result.exitCode);
  };
