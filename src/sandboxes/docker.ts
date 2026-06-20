/**
 * Docker sandbox provider — wraps DockerLifecycle into a SandboxProvider.
 *
 * Usage:
 *   import { docker } from "sandcastle/sandboxes/docker";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: docker() });
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
import { startContainer, removeContainer } from "../DockerLifecycle.js";
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
  processFileMountParents,
} from "../mountUtils.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import { registerShutdown } from "../shutdownRegistry.js";

export interface DockerOptions {
  /** Docker image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /**
   * The UID of the `agent` user inside the container image (default: host UID via `process.getuid()`, or 1000).
   *
   * Must match the UID baked into the image at build time. Used as the `--user` flag value
   * and checked against the image's configured UID in the pre-flight diagnostic.
   */
  readonly containerUid?: number;
  /**
   * The GID of the `agent` user inside the container image (default: host GID via `process.getgid()`, or 1000).
   *
   * Must match the GID baked into the image at build time. Used as the `--user` flag value.
   */
  readonly containerGid?: number;
  /**
   * SELinux volume label suffix applied to bind mounts.
   *
   * - `"z"` — shared label (default). No-op on non-SELinux systems.
   * - `"Z"` — private label; only this container can access the mount.
   * - `false` — disable labeling entirely.
   */
  readonly selinuxLabel?: SelinuxLabel;
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
  /**
   * Supplementary groups to add the container user to, via `--group-add`.
   *
   * Accepts group names or numeric GIDs:
   *
   * - `["docker"]` → `--group-add docker`
   * - `[999]` → `--group-add 999`
   * - `["docker", 999]` → `--group-add docker --group-add 999`
   *
   * Useful for granting access to a bind-mounted Docker socket (Docker-outside-of-Docker).
   * When omitted, no `--group-add` flags are added.
   */
  readonly groups?: readonly (string | number)[];
  /**
   * Host devices to expose to the container, via `--device`.
   *
   * Each entry is a full device spec in `host[:container[:permissions]]` form:
   *
   * - `["/dev/kvm"]` → `--device /dev/kvm`
   * - `["/dev/sda:/dev/xvda:rwm"]` → `--device /dev/sda:/dev/xvda:rwm`
   * - `["/dev/kvm", "/dev/fuse"]` → `--device /dev/kvm --device /dev/fuse`
   *
   * When omitted, no `--device` flags are added.
   */
  readonly devices?: readonly string[];
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
  /**
   * Limit the CPU resources available to the container, via `--cpus`.
   *
   * Maps directly to `docker run --cpus`. Accepts fractional values:
   *
   * - `2` → `--cpus 2` (at most 2 CPUs)
   * - `1.5` → `--cpus 1.5` (at most 1.5 CPUs)
   *
   * When omitted, no `--cpus` flag is added and the container is unconstrained.
   */
  readonly cpus?: number;
}

/**
 * Create a Docker sandbox provider.
 *
 * The returned provider creates Docker containers with bind-mounts
 * for the worktree and git directories.
 */
export const docker = (options?: DockerOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
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
    name: "docker",
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

      // Build volume mount list (internal mounts + user-provided mounts)
      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map((m) => ({
        hostPath: m.hostPath,
        sandboxPath: m.sandboxPath,
        readonly: m.readonly,
      }));

      // Resolve image name
      const imageName =
        configuredImageName ?? defaultImageName(createOptions.hostRepoPath);

      const containerUid = options?.containerUid ?? process.getuid?.() ?? 1000;
      const containerGid = options?.containerGid ?? process.getgid?.() ?? 1000;

      // Pre-flight: verify image exists and UID matches
      await checkImageUid(imageName, containerUid);

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
            user: `${containerUid}:${containerGid}`,
            network: options?.network,
            groups: options?.groups,
            devices: options?.devices,
            cpus: options?.cpus,
            selinuxLabel,
          },
        ),
      );

      // Create parent directories for file mounts and chown to the container user
      for (const dir of parentDirsToCreate) {
        await new Promise<void>((resolve, reject) => {
          execFile(
            "docker",
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

      // Register synchronous container cleanup via the shared shutdown registry
      // so concurrent sandboxes share a single exit/SIGINT/SIGTERM listener
      // instead of tripping Node's MaxListenersExceededWarning.
      const removeContainerSync = () => {
        try {
          execFileSync("docker", ["rm", "-f", containerName], {
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      };
      const unregisterShutdown = registerShutdown(removeContainerSync);

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

            proc.on("error", (error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });

            if (opts?.onLine) {
              const onLine = opts.onLine;
              const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
              const stderrTail = new BoundedTail(maxOutputTailChars, "");
              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutTail.push(line);
                onLine(line);
              });
              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrTail.push(chunk.toString());
              });
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutTail.toString(),
                  stderr: stderrTail.toString(),
                  exitCode: code ?? 0,
                });
              });
            } else {
              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];
              proc.stdout!.on("data", (chunk: Buffer) => {
                stdoutChunks.push(chunk.toString());
              });
              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join(""),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            }
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
          unregisterShutdown();
          await Effect.runPromise(removeContainer(containerName));
        },
      };

      return handle;
    },
  });
};

// Re-export for backwards compatibility
export { defaultImageName };

const checkImageUid = (imageName: string, expectedUid: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile(
      "docker",
      ["image", "inspect", imageName, "--format", "{{.Config.User}}"],
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `Image '${imageName}' not found locally. Build it first with 'sandcastle docker build-image'.`,
            ),
          );
          return;
        }
        const imageUser = (stdout ?? "").toString().trim();
        if (!imageUser) {
          // No USER directive in image — skip check
          resolve();
          return;
        }
        const uidPart = imageUser.split(":")[0]!;
        const imageUid = parseInt(uidPart, 10);
        if (isNaN(imageUid)) {
          // Non-numeric user (e.g. "agent") — can't compare, skip check
          resolve();
          return;
        }
        if (imageUid !== expectedUid) {
          reject(
            new Error(
              `UID mismatch: image '${imageName}' was built with UID ${imageUid}, ` +
                `but the expected UID is ${expectedUid}. ` +
                `Rebuild the image with 'sandcastle docker build-image', ` +
                `or pass containerUid: ${imageUid} to docker() to match the image.`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
  });
