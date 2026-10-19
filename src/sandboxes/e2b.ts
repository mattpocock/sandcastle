/**
 * E2B isolated sandbox provider — wraps the `e2b` SDK into a SandboxProvider.
 *
 * Usage:
 *   import { e2b } from "@ai-hero/sandcastle/sandboxes/e2b";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: e2b() });
 */

import { execFile } from "node:child_process";
import { openAsBlob } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { SandboxOpts } from "e2b";
import { shellEscape } from "../AgentProvider.js";
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";

const execFileAsync = promisify(execFile);

/**
 * Options for the E2B sandbox provider.
 *
 * All `Sandbox.create()` options from the `e2b` SDK are accepted as
 * pass-through (`template`, `timeoutMs`, `apiKey`, `metadata`, `network`, ...),
 * except `envs` and `lifecycle`, which the provider controls.
 *
 * `timeoutMs` defaults to 30 minutes. The sandbox is killed when it expires,
 * so it must cover setup, the agent run, and syncing changes back.
 */
export interface E2BOptions extends Omit<SandboxOpts, "envs" | "lifecycle"> {
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;

  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`.
   */
  readonly maxOutputTailChars?: number;
}

/**
 * Create an E2B isolated sandbox provider.
 *
 * Each sandbox is ephemeral — `create()` starts a new E2B sandbox and
 * `close()` kills it. Requires `e2b` to be installed as a peer dependency
 * and `E2B_API_KEY` in the host environment (or the `apiKey` option).
 */
export const e2b = (options?: E2BOptions): IsolatedSandboxProvider => {
  const {
    env,
    maxOutputTailChars: maxTail = MAX_TAIL_CHARS,
    ...sdkOptions
  } = options ?? {};
  return createIsolatedSandboxProvider({
    name: "e2b",
    env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      // Dynamic import so the peer dependency is only loaded at runtime
      const { Sandbox, CommandExitError, NotFoundError } = await import("e2b");

      const sandbox = await Sandbox.create({
        ...sdkOptions,
        timeoutMs: sdkOptions.timeoutMs ?? 30 * 60 * 1000,
        envs: createOptions.env,
        lifecycle: { onTimeout: "kill", autoResume: false },
      });

      const run = async (command: string): Promise<string> =>
        (await sandbox.commands.run(command, { timeoutMs: 0 })).stdout;

      let worktreePath: string;
      try {
        worktreePath = (
          await run('mkdir -p "$HOME/workspace" && cd "$HOME/workspace" && pwd')
        ).trim();
      } catch (error) {
        await sandbox.kill().catch(() => {});
        throw error;
      }

      return {
        worktreePath,

        exec: async (command, opts) => {
          const onLine = opts?.onLine;
          const stdoutTail = new BoundedTail(maxTail, "\n");
          const stderrTail = new BoundedTail(maxTail, "");
          let partial = "";

          const handle = await sandbox.commands.run(command, {
            background: true,
            cwd: opts?.cwd ?? worktreePath,
            ...(opts?.sudo ? { user: "root" } : {}),
            stdin: opts?.stdin !== undefined,
            timeoutMs: 0,
            ...(onLine
              ? {
                  onStdout: (chunk: string) => {
                    const lines = (partial + chunk).split("\n");
                    partial = lines.pop() ?? "";
                    for (const line of lines) {
                      stdoutTail.push(line);
                      onLine(line);
                    }
                  },
                  onStderr: (chunk: string) => stderrTail.push(chunk),
                }
              : {}),
          });

          if (opts?.stdin !== undefined) {
            try {
              if (opts.stdin) await handle.sendStdin(opts.stdin);
              await handle.closeStdin();
            } catch (error) {
              // The command may exit before reading its input; wait() still
              // reports its result.
              if (!(error instanceof NotFoundError)) {
                await handle.kill().catch(() => {});
                throw error;
              }
            }
          }

          let result: { stdout: string; stderr: string; exitCode: number };
          try {
            result = await handle.wait();
          } catch (error) {
            if (!(error instanceof CommandExitError)) throw error;
            result = error;
          }
          const { stdout, stderr, exitCode } = result;

          if (!onLine) return { stdout, stderr, exitCode };
          if (partial) {
            stdoutTail.push(partial);
            onLine(partial);
          }
          return {
            stdout: stdoutTail.toString(),
            stderr: stderrTail.toString(),
            exitCode,
          };
        },

        copyIn: async (hostPath, sandboxPath) => {
          const info = await stat(hostPath);
          if (!info.isDirectory()) {
            await sandbox.files.write(sandboxPath, await openAsBlob(hostPath));
            // files.write keeps an existing file's mode, so always apply the host's
            const mode = (info.mode & 0o777).toString(8);
            await run(`chmod ${mode} ${shellEscape(sandboxPath)}`);
            return;
          }

          const id = crypto.randomUUID();
          const tarPath = join(tmpdir(), `sandcastle-copyin-${id}.tar.gz`);
          const sandboxTarPath = `/tmp/sandcastle-copyin-${id}.tar.gz`;
          try {
            await execFileAsync("tar", ["-czf", tarPath, "-C", hostPath, "."]);
            await sandbox.files.write(
              sandboxTarPath,
              await openAsBlob(tarPath),
            );
            const tar = shellEscape(sandboxTarPath);
            const dest = shellEscape(sandboxPath);
            // Remove the archive even if extraction fails, keeping its exit code
            await run(
              `mkdir -p ${dest} && tar -xzf ${tar} -C ${dest}; s=$?; rm -f ${tar}; exit $s`,
            );
          } finally {
            await rm(tarPath, { force: true });
          }
        },

        copyFileOut: async (sandboxPath, hostPath) => {
          const content = await sandbox.files.read(sandboxPath, {
            format: "bytes",
          });
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, content);
        },

        close: async () => {
          await sandbox.kill();
        },
      };
    },
  });
};
