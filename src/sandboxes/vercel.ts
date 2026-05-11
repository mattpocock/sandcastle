/**
 * Vercel isolated sandbox provider — wraps `@vercel/sandbox` into a SandboxProvider.
 *
 * Usage:
 *   import { vercel } from "sandcastle/sandboxes/vercel";
 *   await run({ agent: claudeCode("claude-opus-4-7"), sandbox: vercel() });
 */

import { execSync } from "node:child_process";
import { readFile, unlink, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";

/** Worktree path inside the Vercel sandbox. */
const VERCEL_REPO_PATH = "/vercel/sandbox/workspace";

/**
 * Options for creating a Vercel sandbox provider.
 *
 * All `@vercel/sandbox` `Sandbox.create()` options are accepted as pass-through,
 * plus Sandcastle-specific options for auth and branch strategy.
 */
export interface VercelOptions {
  /**
   * Vercel access token.
   *
   * Falls back to the SDK's default auth behavior, which reads
   * `VERCEL_OIDC_TOKEN` (recommended for Vercel-hosted environments) or
   * `VERCEL_TOKEN` from the environment.
   */
  readonly token?: string;

  // ---- Pass-through @vercel/sandbox Sandbox.create() options ----

  /**
   * The source of the sandbox (git repo, tarball, or snapshot).
   * Omit to start an empty sandbox.
   */
  readonly source?:
    | {
        type: "git";
        url: string;
        depth?: number;
        revision?: string;
        username?: string;
        password?: string;
      }
    | {
        type: "tarball";
        url: string;
      }
    | {
        type: "snapshot";
        snapshotId: string;
      };

  /** Array of port numbers to expose from the sandbox (up to 4). */
  readonly ports?: number[];

  /** Timeout in milliseconds before the sandbox auto-terminates. */
  readonly timeout?: number;

  /**
   * Resources to allocate to the sandbox.
   * Each vCPU gets 2048 MB of memory.
   */
  readonly resources?: {
    vcpus: number;
  };

  /**
   * The runtime of the sandbox (e.g. `"node24"`, `"node22"`, `"python3.13"`).
   * Defaults to `"node24"`.
   */
  readonly runtime?: string;

  /**
   * Network policy for the sandbox.
   * Defaults to full internet access if not specified.
   */
  readonly networkPolicy?: Record<string, unknown>;

  /**
   * Vercel project ID to associate sandbox operations with.
   */
  readonly projectId?: string;

  /**
   * Vercel team ID to associate sandbox operations with.
   */
  readonly teamId?: string;

  /**
   * Timeout in milliseconds (alias for `timeout`, kept for discoverability).
   */
  readonly timeoutMs?: number;

  /**
   * Sandbox template shorthand (e.g. `"node-22"`).
   * Maps to the `runtime` option.
   */
  readonly template?: string;

  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
}

/**
 * Create a Vercel isolated sandbox provider.
 *
 * The returned provider creates Vercel Firecracker microVM sandboxes via
 * the `@vercel/sandbox` SDK. Each sandbox is ephemeral — one sandbox per run.
 *
 * Requires `@vercel/sandbox` to be installed as a peer dependency.
 */
export const vercel = (options?: VercelOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "vercel",
    env: options?.env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      // Dynamic import so the peer dependency is only loaded at runtime
      const { Sandbox } = await import("@vercel/sandbox");

      const createParams: Record<string, unknown> = {};

      // Pass through SDK options
      if (options?.source) createParams.source = options.source;
      if (options?.ports) createParams.ports = options.ports;
      if (options?.resources) createParams.resources = options.resources;
      if (options?.networkPolicy)
        createParams.networkPolicy = options.networkPolicy;
      // runtime takes precedence over the template convenience alias
      const resolvedRuntime = options?.runtime ?? options?.template;
      if (resolvedRuntime) createParams.runtime = resolvedRuntime;

      // Timeout: prefer explicit timeout, fall back to timeoutMs alias
      const timeoutValue = options?.timeout ?? options?.timeoutMs;
      if (timeoutValue !== undefined) createParams.timeout = timeoutValue;

      // Merge provider env with Sandcastle env
      createParams.env = createOptions.env;

      // Auth: pass token and team/project IDs if provided
      if (options?.token) createParams.token = options.token;
      if (options?.projectId) createParams.projectId = options.projectId;
      if (options?.teamId) createParams.teamId = options.teamId;

      const sandbox = await Sandbox.create(
        createParams as Parameters<typeof Sandbox.create>[0],
      );

      // Ensure worktree directory exists
      await sandbox.mkDir(VERCEL_REPO_PATH);

      const handle: IsolatedSandboxHandle = {
        worktreePath: VERCEL_REPO_PATH,

        exec: async (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
          },
        ): Promise<ExecResult> => {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            const stdoutLines: string[] = [];
            const stderrChunks: string[] = [];
            let partial = "";

            const stdoutWritable = new Writable({
              write(chunk, _encoding, callback) {
                const text = partial + chunk.toString();
                const lines = text.split("\n");
                partial = lines.pop() ?? "";
                for (const line of lines) {
                  stdoutLines.push(line);
                  onLine(line);
                }
                callback();
              },
              final(callback) {
                if (partial) {
                  stdoutLines.push(partial);
                  onLine(partial);
                  partial = "";
                }
                callback();
              },
            });

            const stderrWritable = new Writable({
              write(chunk, _encoding, callback) {
                stderrChunks.push(chunk.toString());
                callback();
              },
            });

            const result = await sandbox.runCommand({
              cmd: "sh",
              args: ["-c", command],
              cwd: opts?.cwd ?? VERCEL_REPO_PATH,
              stdout: stdoutWritable,
              stderr: stderrWritable,
              ...(opts?.sudo ? { sudo: true } : {}),
            });

            return {
              stdout: stdoutLines.join("\n"),
              stderr: stderrChunks.join(""),
              exitCode: result.exitCode,
            };
          }

          const result = await sandbox.runCommand({
            cmd: "sh",
            args: ["-c", command],
            cwd: opts?.cwd ?? VERCEL_REPO_PATH,
            ...(opts?.sudo ? { sudo: true } : {}),
          });

          const stdout = await result.stdout();
          const stderr = await result.stderr();

          return {
            stdout,
            stderr,
            exitCode: result.exitCode,
          };
        },

        copyIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            const tarPath = join(
              tmpdir(),
              `sandcastle-copyin-${Date.now()}.tar.gz`,
            );
            execSync(`tar -czf "${tarPath}" -C "${hostPath}" .`);
            try {
              const tarContent = await readFile(tarPath);
              const sandboxTarPath = `/tmp/sandcastle-copyin-${Date.now()}.tar.gz`;
              await sandbox.writeFiles([
                { path: sandboxTarPath, content: tarContent },
              ]);
              await sandbox.runCommand({
                cmd: "sh",
                args: [
                  "-c",
                  `mkdir -p "${sandboxPath}" && tar -xzf "${sandboxTarPath}" -C "${sandboxPath}" && rm -f "${sandboxTarPath}"`,
                ],
              });
            } finally {
              await unlink(tarPath).catch(() => {});
            }
          } else {
            const content = await readFile(hostPath);
            await sandbox.writeFiles([{ path: sandboxPath, content }]);
          }
        },

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          const buffer = await sandbox.readFileToBuffer({
            path: sandboxPath,
          });
          if (!buffer) {
            throw new Error(`File not found in Vercel sandbox: ${sandboxPath}`);
          }
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, buffer);
        },

        close: async (): Promise<void> => {
          await sandbox.stop();
        },
      };

      return handle;
    },
  });
