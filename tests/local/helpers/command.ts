import { execFile } from "node:child_process";

/**
 * Runs `command` with `args` (no shell) and resolves its stdout; rejects with
 * its stderr when it exits non-zero. The original error is the `cause`, so a
 * caller can tell a missing binary (`ENOENT`) from a failing one.
 */
export const command = async (
  file: string,
  args: readonly string[],
  options?: { readonly timeout?: number },
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: options?.timeout ?? 120_000 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `\`${file} ${args.join(" ")}\` failed: ${stderr.trim() || error.message}`,
              { cause: error },
            ),
          );
        }
      },
    );
  });
