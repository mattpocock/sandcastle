/**
 * Docker-compose sandbox provider — wraps a user-managed `docker-compose.yml`
 * into a SandboxProvider.
 *
 * Sandcastle delegates container configuration (image, networks, GPUs,
 * resource limits, dependent services) to the compose file. It only injects
 * the per-run worktree bind mount, workdir, and env vars, then invokes
 * `docker compose run -d`.
 *
 * Usage:
 *   import { dockerCompose } from "sandcastle/sandboxes/docker-compose";
 *   await run({
 *     agent: claudeCode("claude-opus-4-6"),
 *     sandbox: dockerCompose({ composeFile: ".sandcastle/docker-compose.yml" }),
 *   });
 */

import {
  execFile,
  execFileSync,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { startContainer, removeContainer } from "../DockerComposeLifecycle.js";
import {
  createBindMountSandboxProvider,
  type SandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
  type InteractiveExecOptions,
} from "../SandboxProvider.js";
import type { MountConfig } from "../MountConfig.js";
import { resolveUserMounts } from "../mountUtils.js";

export interface DockerComposeOptions {
  /**
   * Path to the compose file. Resolved against `process.cwd()` if relative.
   * When omitted, docker compose auto-discovers from the project directory.
   *
   * Common values: `".sandcastle/docker-compose.yml"`, `"docker-compose.yml"`.
   */
  readonly composeFile?: string;
  /**
   * Service name from the compose file to run. Defaults to `"agent"`.
   */
  readonly serviceName?: string;
  /**
   * Project directory passed to `docker compose --project-directory`.
   * When omitted, defaults to `process.cwd()`. Relative paths inside the
   * compose file resolve against this directory.
   */
  readonly projectDirectory?: string;
  /**
   * Compose project name (`-p` flag). When omitted, docker compose derives it
   * from the project directory. Pass a unique value (e.g. per-session) to
   * avoid collisions when multiple sandcastle runs share a project directory.
   */
  readonly projectName?: string;
  /**
   * Additional host directories to bind-mount into the sandbox.
   *
   * Each entry specifies a `hostPath` (tilde-expanded) and `sandboxPath`.
   * If `hostPath` does not exist, sandbox creation fails with a clear error.
   *
   * These are merged with the worktree bind mount sandcastle injects.
   * For mounts that should be visible to dependent services, declare them
   * in the compose file instead.
   */
  readonly mounts?: readonly MountConfig[];
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
}

/**
 * Create a docker-compose sandbox provider.
 *
 * The returned provider invokes `docker compose run -d` against the configured
 * service. The compose file owns image, networks, GPU reservations, resource
 * limits, and dependent services; sandcastle only injects the worktree mount
 * and workdir.
 */
export const dockerCompose = (
  options?: DockerComposeOptions,
): SandboxProvider => {
  const serviceName = options?.serviceName ?? "agent";
  const sandboxHomedir = "/home/agent";
  const userMounts = options?.mounts
    ? resolveUserMounts(options.mounts, sandboxHomedir)
    : [];

  const composeFile = options?.composeFile
    ? isAbsolute(options.composeFile)
      ? options.composeFile
      : resolvePath(process.cwd(), options.composeFile)
    : undefined;

  if (composeFile && !existsSync(composeFile)) {
    throw new Error(
      `Compose file does not exist: ${options?.composeFile} (resolved to ${composeFile})`,
    );
  }

  return createBindMountSandboxProvider({
    name: "docker-compose",
    env: options?.env,
    sandboxHomedir,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const containerName = `sandcastle-${randomUUID()}`;

      const worktreePath =
        createOptions.mounts.find(
          (m) => m.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? "/home/agent/workspace";

      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map((m) => ({
        hostPath: m.hostPath,
        sandboxPath: m.sandboxPath,
        readonly: m.readonly,
      }));

      const projectDirectory = options?.projectDirectory ?? process.cwd();

      try {
        await Effect.runPromise(
          startContainer(
            containerName,
            serviceName,
            {
              ...createOptions.env,
              HOME: "/home/agent",
            },
            {
              volumeMounts,
              workdir: worktreePath,
              composeFile,
              projectDirectory,
              projectName: options?.projectName,
            },
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `docker compose run failed for service '${serviceName}': ${message}`,
        );
      }

      const onExit = () => {
        try {
          execFileSync("docker", ["rm", "-f", containerName], {
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      };
      const onSignal = () => {
        onExit();
        process.exit(1);
      };
      process.on("exit", onExit);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      const handle: BindMountSandboxHandle = {
        worktreePath,

        exec: (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            stdin?: string;
          },
        ): Promise<ExecResult> => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          const args = ["exec"];
          if (opts?.stdin !== undefined) args.push("-i");
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);

          return new Promise((resolve, reject) => {
            const proc = spawn("docker", args, {
              stdio: [
                opts?.stdin !== undefined ? "pipe" : "ignore",
                "pipe",
                "pipe",
              ],
            });

            if (opts?.stdin !== undefined) {
              proc.stdin!.write(opts.stdin);
              proc.stdin!.end();
            }

            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];

            if (opts?.onLine) {
              const onLine = opts.onLine;
              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line);
              });
            } else {
              proc.stdout!.on("data", (chunk: Buffer) => {
                stdoutChunks.push(chunk.toString());
              });
            }

            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });

            proc.on("error", (error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });

            proc.on("close", (code) => {
              resolve({
                stdout: stdoutChunks.join(opts?.onLine ? "\n" : ""),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              });
            });
          });
        },

        interactiveExec: (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> => {
          return new Promise((resolve, reject) => {
            const dockerArgs = ["exec"];
            if (
              "isTTY" in opts.stdin &&
              (opts.stdin as { isTTY?: boolean }).isTTY
            ) {
              dockerArgs.push("-it");
            } else {
              dockerArgs.push("-i");
            }
            if (opts.cwd) dockerArgs.push("-w", opts.cwd);
            dockerArgs.push(containerName, ...args);

            const proc = spawn("docker", dockerArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            });

            proc.on("error", (error: Error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });

            proc.on("close", (code: number | null) => {
              resolve({ exitCode: code ?? 0 });
            });
          });
        },

        copyFileIn: (hostPath: string, sandboxPath: string): Promise<void> =>
          new Promise((resolve, reject) => {
            execFile(
              "docker",
              ["cp", hostPath, `${containerName}:${sandboxPath}`],
              (error) => {
                if (error) {
                  reject(new Error(`docker cp (in) failed: ${error.message}`));
                } else {
                  resolve();
                }
              },
            );
          }),

        copyFileOut: (sandboxPath: string, hostPath: string): Promise<void> =>
          new Promise((resolve, reject) => {
            execFile(
              "docker",
              ["cp", `${containerName}:${sandboxPath}`, hostPath],
              (error) => {
                if (error) {
                  reject(new Error(`docker cp (out) failed: ${error.message}`));
                } else {
                  resolve();
                }
              },
            );
          }),

        close: async (): Promise<void> => {
          process.removeListener("exit", onExit);
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
          await Effect.runPromise(removeContainer(containerName));
        },
      };

      return handle;
    },
  });
};
