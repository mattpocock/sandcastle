/**
 * Daytona isolated sandbox provider.
 *
 * Creates ephemeral Daytona sandboxes via `@daytona/sdk`.
 * Requires `@daytona/sdk` as a peer dependency.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import {
  redirectCommandStdinFromFile,
  removeStdinFileCommand,
  withStdinFile,
} from "./stdin-file.js";

import type {
  Daytona as DaytonaClient,
  DaytonaConfig,
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
} from "@daytona/sdk";

/** Options for the Daytona sandbox provider. */
export interface DaytonaOptions {
  /**
   * Daytona API key for authentication.
   * Falls back to the `DAYTONA_API_KEY` environment variable if not provided.
   */
  readonly apiKey?: string;

  /**
   * Daytona API URL.
   * Falls back to the `DAYTONA_API_URL` environment variable if not provided.
   */
  readonly apiUrl?: string;

  /**
   * Target environment for sandboxes.
   * Falls back to the `DAYTONA_TARGET` environment variable if not provided.
   */
  readonly target?: string;

  /**
   * Options passed through to the Daytona SDK when creating a sandbox.
   * Supports both image-based and snapshot-based creation.
   */
  readonly create?:
    CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams;

  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;

  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
}

/**
 * Create a Daytona isolated sandbox provider.
 *
 * Sandboxes are ephemeral — each `create()` call spins up a new Daytona
 * sandbox and `close()` destroys it.
 *
 * @example
 * ```ts
 * import { daytona } from "@ai-hero/sandcastle/sandboxes/daytona";
 *
 * const provider = daytona({ apiKey: "dyt_my_key" });
 * ```
 */
export const daytona = (options?: DaytonaOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "daytona",
    env: options?.env,
    create: async (): Promise<IsolatedSandboxHandle> => {
      const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
      const { Daytona } =
        (await import("@daytona/sdk")) as typeof import("@daytona/sdk");

      const config: DaytonaConfig = {};
      if (options?.apiKey) config.apiKey = options.apiKey;
      if (options?.apiUrl) config.apiUrl = options.apiUrl;
      if (options?.target) config.target = options.target;

      const client: DaytonaClient = new Daytona(config);
      const sandbox = await client.create(options?.create as any);

      const worktreePath =
        (await sandbox.getWorkDir()) ??
        (await sandbox.getUserHomeDir()) ??
        "/home/daytona";

      return {
        worktreePath,

        exec: async (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            stdin?: string;
          },
        ): Promise<ExecResult> => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          const stdin = opts?.stdin;
          const cwd = opts?.cwd ?? worktreePath;

          return withStdinFile(
            stdin,
            {
              upload: (path, content) => sandbox.fs.uploadFile(content, path),
              remove: async (path) => {
                await sandbox.process.executeCommand(
                  removeStdinFileCommand(path),
                );
              },
            },
            async (stdinPath) => {
              const commandToRun = stdinPath
                ? redirectCommandStdinFromFile(effectiveCommand, stdinPath)
                : effectiveCommand;

              if (opts?.onLine) {
                const onLine = opts.onLine;
                const sessionId = `sandcastle-${crypto.randomUUID()}`;
                await sandbox.process.createSession(sessionId);

                try {
                  const execResponse =
                    await sandbox.process.executeSessionCommand(sessionId, {
                      command: `cd ${cwd} && ${commandToRun}`,
                      async: true,
                    });

                  const cmdId = execResponse.cmdId!;

                  const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
                  const stderrTail = new BoundedTail(maxOutputTailChars, "");
                  let partial = "";

                  await sandbox.process.getSessionCommandLogs(
                    sessionId,
                    cmdId,
                    (chunk: string) => {
                      const text = partial + chunk;
                      const lines = text.split("\n");
                      partial = lines.pop() ?? "";
                      for (const line of lines) {
                        stdoutTail.push(line);
                        onLine(line);
                      }
                    },
                    (chunk: string) => {
                      stderrTail.push(chunk);
                    },
                  );

                  if (partial) {
                    stdoutTail.push(partial);
                    onLine(partial);
                  }

                  const cmdInfo = await sandbox.process.getSessionCommand(
                    sessionId,
                    cmdId,
                  );

                  return {
                    stdout: stdoutTail.toString(),
                    stderr: stderrTail.toString(),
                    exitCode: cmdInfo.exitCode ?? 0,
                  };
                } finally {
                  await sandbox.process
                    .deleteSession(sessionId)
                    .catch(() => {});
                }
              }

              const response = await sandbox.process.executeCommand(
                commandToRun,
                cwd,
              );
              return {
                stdout: response.result,
                stderr: "",
                exitCode: response.exitCode,
              };
            },
          );
        },

        copyIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            const walk = async (dir: string): Promise<string[]> => {
              const entries = await readdir(dir, { withFileTypes: true });
              const files: string[] = [];
              for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                  files.push(...(await walk(full)));
                } else {
                  files.push(full);
                }
              }
              return files;
            };
            const files = await walk(hostPath);
            for (const file of files) {
              const rel = relative(hostPath, file);
              await sandbox.fs.uploadFile(file, join(sandboxPath, rel));
            }
          } else {
            await sandbox.fs.uploadFile(hostPath, sandboxPath);
          }
        },

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          await sandbox.fs.downloadFile(sandboxPath, hostPath);
        },

        close: async (): Promise<void> => {
          await client.delete(sandbox);
        },
      };
    },
  });
