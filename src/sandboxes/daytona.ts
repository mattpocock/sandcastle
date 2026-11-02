/**
 * Daytona isolated sandbox provider.
 *
 * Creates ephemeral Daytona sandboxes via `@daytona/sdk`.
 * Requires `@daytona/sdk` as a peer dependency.
 */

import { readdir, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { createIsolatedSandboxProvider } from "../SandboxProvider.js";
import type {
  ExecResult,
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";

import type {
  Daytona as DaytonaClient,
  DaytonaConfig,
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
} from "@daytona/sdk";

const shellEscape = (s: string): string =>
  `'${s.replaceAll("'", String.raw`'\''`)}'`;

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
    | CreateSandboxFromImageParams
    | CreateSandboxFromSnapshotParams;

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

/** How often a streamed `exec` checks that its session shell is still alive. */
const SESSION_WATCH_INTERVAL_MS = 15_000;

/** The Daytona client config: only the connection options that are set. */
const toDaytonaConfig = (options?: DaytonaOptions): DaytonaConfig => {
  const { apiKey, apiUrl, target } = options ?? {};
  const config: DaytonaConfig = {};
  if (apiKey !== undefined && apiKey !== "") {
    config.apiKey = apiKey;
  }
  if (apiUrl !== undefined && apiUrl !== "") {
    config.apiUrl = apiUrl;
  }
  if (target !== undefined && target !== "") {
    config.target = target;
  }
  return config;
};

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
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
      const { Daytona } = (await import(
        "@daytona/sdk"
      )) as typeof import("@daytona/sdk");

      const client: DaytonaClient = new Daytona(toDaytonaConfig(options));
      // Pass the resolved env (env resolver + provider + agent) to the
      // sandbox. Explicit `create.envVars` win, as the most specific source.
      const createParams = options?.create;
      const envVars = { ...createOptions.env, ...createParams?.envVars };
      // `client.create` is overloaded per params shape, so call the overload
      // that matches instead of passing the union.
      const sandbox =
        createParams !== undefined && "image" in createParams
          ? await client.create({ ...createParams, envVars })
          : await client.create({ ...createParams, envVars });

      const workDir =
        (await sandbox.getWorkDir()) ??
        (await sandbox.getUserHomeDir()) ??
        "/home/daytona";

      // Use a subdirectory of the work dir, not the work dir itself: sync-in
      // clones into `${worktreePath}_clone` and then replaces worktreePath,
      // which needs a parent the sandbox user can write. On the default
      // snapshot the work dir is the user's home (/home/daytona), and /home
      // is root-owned.
      const worktreePath = posix.join(workDir, "workspace");
      await sandbox.fs.createFolder(worktreePath, "755");

      return {
        worktreePath,
        sandboxId: sandbox.id,

        exec: async (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            stdin?: string;
          },
        ): Promise<ExecResult> => {
          // Wrap the whole command in `sh -c`, so sudo elevates all of it
          // (`a && b`, not just `a`).
          let effectiveCommand =
            opts?.sudo === true
              ? `sudo sh -c ${shellEscape(command)}`
              : command;
          if (opts?.stdin !== undefined) {
            // Daytona's exec APIs have no stdin channel: the command reads
            // EOF. So write stdin to a file in the sandbox and redirect it in
            // (a file, not an argument, keeps clear of the per-arg size
            // limit). The redirect opens the file before the group runs, so
            // the group can delete it straight away and leave nothing behind.
            const stdinPath = `/tmp/sandcastle-stdin-${crypto.randomUUID()}`;
            await sandbox.fs.uploadFile(Buffer.from(opts.stdin), stdinPath);
            effectiveCommand = `{ rm -f ${stdinPath}; ${effectiveCommand}\n} < ${stdinPath}`;
          }
          if (opts?.onLine) {
            const { onLine } = opts;
            const sessionId = `sandcastle-${crypto.randomUUID()}`;
            const pidPath = `/tmp/${sessionId}.pid`;
            await sandbox.process.createSession(sessionId);

            try {
              // A session runs its commands in one long-lived shell, which
              // records each command's exit code once it returns. A command
              // that ends that shell (a top-level `exit`) never gets one, and
              // its log stream never closes. So run the command in a subshell,
              // where `exit` ends only the subshell. The newline before `)`
              // keeps a trailing comment from swallowing it. The session
              // shell's PID goes to a file, to check it is still alive.
              const execResponse = await sandbox.process.executeSessionCommand(
                sessionId,
                {
                  command: `echo $$ > ${pidPath}; ( cd ${opts?.cwd ?? worktreePath} && ${effectiveCommand}\n)`,
                  async: true,
                },
              );

              const { cmdId } = execResponse;

              const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
              const stderrTail = new BoundedTail(maxOutputTailChars, "");
              let partial = "";

              const logsDone = sandbox.process.getSessionCommandLogs(
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

              // Once the race below is lost, a late failure of the stream
              // must not surface as an unhandled rejection.
              logsDone.catch(() => {});

              // If the session shell dies anyway (killed, say), the stream
              // would wait forever. Watch the shell, and once it is gone stop
              // waiting: fail if the command recorded no exit code. A missing
              // PID file counts as alive, so it can never fail a command.
              let watchTimer: ReturnType<typeof setTimeout> | undefined;
              let watching = true;
              const sessionGone = new Promise<void>((resolve, reject) => {
                const check = async () => {
                  const alive = await sandbox.process
                    .executeCommand(
                      `test ! -f ${pidPath} || kill -0 "$(cat ${pidPath})"`,
                    )
                    .then((r) => r.exitCode === 0)
                    .catch(() => true);
                  const cmd = alive
                    ? undefined
                    : await sandbox.process
                        .getSessionCommand(sessionId, cmdId)
                        .catch(() => undefined);
                  if (!watching) {
                    return;
                  }
                  if (alive) {
                    watchTimer = setTimeout(check, SESSION_WATCH_INTERVAL_MS);
                    return;
                  }
                  if (typeof cmd?.exitCode === "number") {
                    return resolve();
                  }
                  reject(
                    new Error(
                      `Daytona session shell exited before the command finished, so its exit code is unknown: ${command}`,
                    ),
                  );
                };
                watchTimer = setTimeout(check, SESSION_WATCH_INTERVAL_MS);
              });

              try {
                await Promise.race([logsDone, sessionGone]);
              } finally {
                watching = false;
                clearTimeout(watchTimer);
              }

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
              await sandbox.process.deleteSession(sessionId).catch(() => {});
              await sandbox.process
                .executeCommand(`rm -f ${pidPath}`)
                .catch(() => {});
            }
          }

          const response = await sandbox.process.executeCommand(
            effectiveCommand,
            opts?.cwd ?? worktreePath,
          );
          // `executeCommand` merges stdout and stderr into `result` and has
          // no separate stderr. On failure, surface that output as stderr
          // too, so the error says why the command failed, not just its exit
          // code.
          return {
            stdout: response.result,
            stderr: response.exitCode === 0 ? "" : response.result,
            exitCode: response.exitCode,
          };
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
