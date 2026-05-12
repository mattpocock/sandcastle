/**
 * Podman sandbox provider — creates Podman containers with bind-mounts.
 *
 * Usage:
 *   import { podman } from "sandcastle/sandboxes/podman";
 *   await run({ agent: claudeCode("claude-opus-4-7"), sandbox: podman() });
 */

import {
  execFile,
  execFileSync,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  createBindMountSandboxProvider,
  type SandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
  type InteractiveExecOptions,
} from "../SandboxProvider.js";
import type { MountConfig } from "../MountConfig.js";
import type { SelinuxLabel } from "../mountUtils.js";
import {
  defaultImageName,
  resolveUserMounts,
  formatVolumeMount,
  processFileMountParents,
} from "../mountUtils.js";

export interface PodmanOptions {
  /** Podman image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /**
   * SELinux volume label suffix applied to bind mounts.
   *
   * - `"z"` — shared label (default). No-op on non-SELinux systems.
   * - `"Z"` — private label; only this container can access the mount.
   * - `false` — disable labeling entirely.
   */
  readonly selinuxLabel?: SelinuxLabel;
  /**
   * User namespace mode for rootless Podman.
   *
   * - `"keep-id"` (default) — maps host UID to `containerUid` inside the
   *   container via `--userns=keep-id:uid=N,gid=N`, so both bind-mounted
   *   files and image-built files have correct ownership without chown.
   * - `false` — disable; use for rootful Podman setups.
   */
  readonly userns?: "keep-id" | false;
  /**
   * The UID of the `agent` user inside the container image (default: 1000).
   *
   * Must match the UID set in the Containerfile. Used with `--userns=keep-id`
   * to map the host user to this UID inside the container.
   */
  readonly containerUid?: number;
  /**
   * The GID of the `agent` user inside the container image (default: 1000).
   *
   * Must match the GID set in the Containerfile. Used with `--userns=keep-id`
   * to map the host group to this GID inside the container.
   */
  readonly containerGid?: number;
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
   * Podman network(s) to attach the container to.
   *
   * - `"my-network"` → `--network my-network`
   * - `["net1", "net2"]` → `--network net1 --network net2`
   *
   * When omitted, Podman's default network is used.
   */
  readonly network?: string | readonly string[];
}

/**
 * Create a Podman sandbox provider.
 *
 * The returned provider creates Podman containers with bind-mounts
 * for the worktree and git directories. Calls the `podman` binary
 * on PATH directly. On macOS/Windows, verifies that a Podman Machine
 * is running before container creation.
 */
export const podman = (options?: PodmanOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const userns = options?.userns ?? "keep-id";
  const containerUid = options?.containerUid ?? 1000;
  const containerGid = options?.containerGid ?? 1000;
  const sandboxHomedir = "/home/agent";
  const userMounts = options?.mounts
    ? resolveUserMounts(options.mounts, sandboxHomedir)
    : [];
  // Validate file mounts and collect parent dirs to create at container start.
  // Throws at construction time if any file mount parent is outside sandboxHomedir.
  const parentDirsToCreate = processFileMountParents(
    userMounts,
    sandboxHomedir,
  );

  return createBindMountSandboxProvider({
    name: "podman",
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

      // Build volume mount strings with optional SELinux label (internal + user mounts)
      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map((m) =>
        formatVolumeMount(m, selinuxLabel),
      );

      // Resolve image name
      const imageName =
        configuredImageName ?? defaultImageName(createOptions.hostRepoPath);

      // Pre-flight: check Podman Machine on macOS/Windows
      if (process.platform === "darwin" || process.platform === "win32") {
        await checkPodmanMachine();
      }

      // Pre-flight: verify image exists locally
      await checkImageExists(imageName);

      const env = { ...createOptions.env, HOME: "/home/agent" };
      const envArgs = Object.entries(env).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]);
      const volumeArgs = volumeMounts.flatMap((v) => ["-v", v]);
      const usernsArgs = userns
        ? [`--userns=keep-id:uid=${containerUid},gid=${containerGid}`]
        : [];
      const userArgs = ["--user", `${containerUid}:${containerGid}`];
      const networks = options?.network
        ? Array.isArray(options.network)
          ? options.network
          : [options.network]
        : [];
      const networkArgs = networks.flatMap((n) => ["--network", n]);

      // Start container via podman run
      await new Promise<void>((resolve, reject) => {
        execFile(
          "podman",
          [
            "run",
            "-d",
            "--name",
            containerName,
            ...userArgs,
            ...usernsArgs,
            ...networkArgs,
            "-w",
            worktreePath,
            ...envArgs,
            ...volumeArgs,
            "--entrypoint",
            "sleep",
            imageName,
            "infinity",
          ],
          (error) => {
            if (error) {
              reject(new Error(`podman run failed: ${error.message}`));
            } else {
              resolve();
            }
          },
        );
      });

      // Create parent directories for file mounts and chown to the container user
      for (const dir of parentDirsToCreate) {
        await new Promise<void>((resolve, reject) => {
          execFile(
            "podman",
            [
              "exec",
              "--user",
              "0:0",
              containerName,
              "sh",
              "-c",
              `mkdir -p "$1" && chown "$2" "$1"`,
              "sh",
              dir,
              `${containerUid}:${containerGid}`,
            ],
            (error) => {
              if (error) {
                reject(
                  new Error(
                    `Failed to create parent directory '${dir}' in container: ${error.message}`,
                  ),
                );
              } else {
                resolve();
              }
            },
          );
        });
      }

      // Set up signal handlers for cleanup
      const onExit = () => {
        try {
          execFileSync("podman", ["rm", "-f", containerName], {
            stdio: "ignore",
            timeout: 5000,
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
            const proc = spawn("podman", args, {
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
              reject(new Error(`podman exec failed: ${error.message}`));
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
            const podmanArgs = ["exec"];
            // Allocate a pseudo-terminal when stdin looks like a TTY
            if (
              "isTTY" in opts.stdin &&
              (opts.stdin as { isTTY?: boolean }).isTTY
            ) {
              podmanArgs.push("-it");
            } else {
              podmanArgs.push("-i");
            }
            if (opts.cwd) podmanArgs.push("-w", opts.cwd);
            podmanArgs.push(containerName, ...args);

            const proc = spawn("podman", podmanArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            });

            proc.on("error", (error: Error) => {
              reject(new Error(`podman exec failed: ${error.message}`));
            });

            proc.on("close", (code: number | null) => {
              resolve({ exitCode: code ?? 0 });
            });
          });
        },

        copyFileIn: (hostPath: string, sandboxPath: string): Promise<void> =>
          new Promise((resolve, reject) => {
            execFile(
              "podman",
              ["cp", hostPath, `${containerName}:${sandboxPath}`],
              (error) => {
                if (error) {
                  reject(new Error(`podman cp (in) failed: ${error.message}`));
                } else {
                  resolve();
                }
              },
            );
          }),

        copyFileOut: (sandboxPath: string, hostPath: string): Promise<void> =>
          new Promise((resolve, reject) => {
            execFile(
              "podman",
              ["cp", `${containerName}:${sandboxPath}`, hostPath],
              (error) => {
                if (error) {
                  reject(new Error(`podman cp (out) failed: ${error.message}`));
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
          await new Promise<void>((resolve, reject) => {
            execFile("podman", ["rm", "-f", containerName], (error) => {
              if (error) {
                reject(new Error(`podman rm failed: ${error.message}`));
              } else {
                resolve();
              }
            });
          });
        },
      };

      return handle;
    },
  });
};

// Re-export for backwards compatibility
export { defaultImageName };

const checkImageExists = (imageName: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile("podman", ["image", "inspect", imageName], (error) => {
      if (error) {
        reject(
          new Error(
            `Image '${imageName}' not found locally. Build it first with 'podman build -t ${imageName} .'`,
          ),
        );
      } else {
        resolve();
      }
    });
  });

const podmanMachineError = () =>
  new Error(
    "Podman Machine is not running. Run 'podman machine init && podman machine start' first.",
  );

const checkPodmanMachine = (): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile(
      "podman",
      ["machine", "list", "--format", "json"],
      (error, stdout) => {
        if (error) {
          reject(podmanMachineError());
          return;
        }
        try {
          const machines = JSON.parse(stdout.toString()) as Array<{
            Running?: boolean;
          }>;
          if (machines.some((m) => m.Running)) {
            resolve();
          } else {
            reject(podmanMachineError());
          }
        } catch {
          reject(podmanMachineError());
        }
      },
    );
  });
