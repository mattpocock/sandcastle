/**
 * Docker sandbox provider — wraps DockerLifecycle into a SandboxProvider.
 *
 * Usage:
 *   import { docker } from "sandcastle/sandboxes/docker";
 *   await run({ agent: claudeCode("claude-opus-4-6"), sandbox: docker() });
 */

import {
  execFile,
  execFileSync,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import {
  startContainer,
  removeContainer,
  chownInContainer,
} from "../DockerLifecycle.js";
import {
  createBindMountSandboxProvider,
  type SandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
  type InteractiveExecOptions,
} from "../SandboxProvider.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { MountConfig } from "../MountConfig.js";
import { SANDBOX_REPO_DIR } from "../SandboxFactory.js";

export interface DockerOptions {
  /** Docker image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /**
   * Additional host directories to bind-mount into the sandbox.
   *
   * Each entry specifies a `hostPath` (tilde-expanded) and `sandboxPath`.
   * If `hostPath` does not exist, sandbox creation fails with a clear error.
   */
  readonly mounts?: readonly MountConfig[];
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
  /**
   * Docker network(s) to attach the container to.
   *
   * - `"my-network"` → `--network my-network`
   * - `["net1", "net2"]` → `--network net1 --network net2`
   *
   * When omitted, Docker's default bridge network is used.
   */
  readonly network?: string | readonly string[];
}

/**
 * Create a Docker sandbox provider.
 *
 * The returned provider creates Docker containers with bind-mounts
 * for the worktree and git directories.
 */
export const docker = (options?: DockerOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;
  const userMounts = options?.mounts ? resolveUserMounts(options.mounts) : [];

  return createBindMountSandboxProvider({
    name: "docker",
    env: options?.env,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const containerName = `sandcastle-${randomUUID()}`;

      const worktreePath =
        createOptions.mounts.find(
          (m) => m.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? "/home/agent/workspace";

      // Build volume mount strings (internal mounts + user-provided mounts)
      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map((m) => {
        const base = `${m.hostPath}:${m.sandboxPath}`;
        return m.readonly ? `${base}:ro` : base;
      });

      // Resolve image name
      const imageName =
        configuredImageName ?? defaultImageName(createOptions.hostRepoPath);

      const hostUid = process.getuid?.() ?? 1000;
      const hostGid = process.getgid?.() ?? 1000;

      // Start container
      await Effect.runPromise(
        startContainer(
          containerName,
          imageName,
          {
            ...createOptions.env,
            HOME: "/home/agent",
          },
          {
            volumeMounts,
            workdir: worktreePath,
            user: `${hostUid}:${hostGid}`,
            network: options?.network,
          },
        ).pipe(
          Effect.andThen(
            chownInContainer(
              containerName,
              `${hostUid}:${hostGid}`,
              "/home/agent",
            ),
          ),
        ),
      );

      // Set up signal handlers for cleanup
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
        supportsStdinExec: true,

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
          // `-i` keeps stdin open so we can pipe opts.stdin into the container process
          if (opts?.stdin !== undefined) args.push("-i");
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);

          const stdinPayload = opts?.stdin;
          const stdinMode: "pipe" | "ignore" =
            stdinPayload !== undefined ? "pipe" : "ignore";

          if (opts?.onLine || stdinPayload !== undefined) {
            const onLine = opts?.onLine;
            return new Promise((resolve, reject) => {
              const proc = spawn("docker", args, {
                stdio: [stdinMode, "pipe", "pipe"],
              });

              if (stdinPayload !== undefined && proc.stdin) {
                proc.stdin.on("error", (error: Error) => {
                  reject(
                    new Error(`docker exec stdin failed: ${error.message}`),
                  );
                });
                proc.stdin.end(stdinPayload);
              }

              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];

              if (onLine) {
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
                  stdout: stdoutChunks.join(onLine ? "\n" : ""),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            });
          }

          return new Promise((resolve, reject) => {
            execFile(
              "docker",
              args,
              { maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`docker exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          });
        },

        interactiveExec: (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> => {
          return new Promise((resolve, reject) => {
            const dockerArgs = ["exec"];
            // Allocate a pseudo-terminal when stdin looks like a TTY
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

/**
 * Derive the default Docker image name from the repo directory.
 * Returns `sandcastle:<dir-name>` where dir-name is the last path segment,
 * lowercased and sanitized for Docker image tag rules.
 */
export const defaultImageName = (repoDir: string): string => {
  const dirName = repoDir.replace(/\/+$/, "").split("/").pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized}`;
};

const expandTilde = (p: string): string => {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
};

const resolveHostPath = (hostPath: string): string => {
  const expanded = expandTilde(hostPath);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
};

const resolveSandboxPath = (sandboxPath: string): string =>
  isAbsolute(sandboxPath)
    ? sandboxPath
    : resolve(SANDBOX_REPO_DIR, sandboxPath);

const resolveUserMounts = (
  mounts: readonly MountConfig[],
): Array<{ hostPath: string; sandboxPath: string; readonly?: boolean }> =>
  mounts.map((m) => {
    const resolvedHostPath = resolveHostPath(m.hostPath);

    if (!existsSync(resolvedHostPath)) {
      throw new Error(
        `Mount hostPath does not exist: ${m.hostPath}` +
          (m.hostPath !== resolvedHostPath
            ? ` (resolved to ${resolvedHostPath})`
            : ""),
      );
    }

    return {
      hostPath: resolvedHostPath,
      sandboxPath: resolveSandboxPath(m.sandboxPath),
      ...(m.readonly ? { readonly: true } : {}),
    };
  });
