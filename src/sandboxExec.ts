import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";

const execAsync = promisify(exec);

/** Execute a command on the host side, returning stdout. Throws on non-zero exit. */
export const execHost = async (
  command: string,
  cwd: string,
): Promise<string> => {
  try {
    const { stdout } = await execAsync(command, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Host command failed: ${command}\n${message}`, {
      cause: error,
    });
  }
};

/** Execute a command in the sandbox, throwing if it fails. */
export const execOk = async (
  handle: IsolatedSandboxHandle,
  command: string,
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const result = await handle.exec(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
    );
  }
  return result;
};
