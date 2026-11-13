/**
 * Test helper: runs a shell command on the host for the unit tests in src/,
 * which set up git repos and files directly. One typed replacement for the
 * `promisify(exec)` each test file used to define for itself.
 */
import { exec } from "node:child_process";
import type { ExecException } from "node:child_process";
import { promisify } from "node:util";

export interface ExecAsyncOptions {
  /** The directory the command runs in. */
  readonly cwd: string;
  /** The command's environment. `undefined` gives it the host's. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface ExecAsyncResult {
  readonly stdout: string;
  readonly stderr: string;
}

const execWithCallback = (
  command: string,
  options: ExecAsyncOptions,
  callback: (error: ExecException | null, result: ExecAsyncResult) => void,
): void => {
  exec(command, options, (error, stdout, stderr) => {
    // Like `promisify(exec)`, a failed command's error carries its output.
    callback(error && Object.assign(error, { stdout, stderr }), {
      stdout,
      stderr,
    });
  });
};

/**
 * Runs `command` in a shell in `options.cwd`, with `options.env` when given.
 * Resolves with its output, or rejects on a non-zero exit with the
 * `Command failed: <command>` error that `promisify(exec)` gives.
 */
export const execAsync: (
  command: string,
  options: ExecAsyncOptions,
) => Promise<ExecAsyncResult> = promisify(execWithCallback);
