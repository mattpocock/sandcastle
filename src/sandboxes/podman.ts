/**
 * Podman sandbox provider — creates Podman containers with bind-mounts.
 *
 * Usage:
 *   import { podman } from "sandcastle/sandboxes/podman";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: podman() });
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { createBindMountSandboxProvider } from "../SandboxProvider.js";
import type {
  SandboxProvider,
  BindMountCreateOptions,
  BindMountSandboxHandle,
  ExecResult,
  InteractiveExecOptions,
} from "../SandboxProvider.js";
import type { MountConfig } from "../MountConfig.js";
import type { SelinuxLabel } from "../mountUtils.js";
import type { LinuxCapability } from "../LinuxCapability.js";
import {
  defaultImageName,
  resolveUserMounts,
  formatVolumeMount,
  processFileMountParents,
} from "../mountUtils.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import { registerShutdown } from "../shutdownRegistry.js";

export type { LinuxCapability } from "../LinuxCapability.js";

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
   * Linux capabilities to drop from the container, via `--cap-drop`.
   *
   * Names are written without the `CAP_` prefix, as `podman run` accepts them,
   * and a misspelt name is a type error:
   *
   * - `["NET_RAW"]` → `--cap-drop NET_RAW` (no raw sockets, so no `ping`)
   * - `["NET_RAW", "MKNOD"]` → `--cap-drop NET_RAW --cap-drop MKNOD`
   * - `["ALL"]` → `--cap-drop ALL` (drop every capability)
   *
   * When omitted, no `--cap-drop` flags are added and the container keeps
   * Podman's default capability set.
   */
  readonly capDrop?: readonly LinuxCapability[];
  /**
   * Host devices to expose to the container, via `--device`.
   *
   * Each entry is a full device spec in `host[:container[:permissions]]` form:
   *
   * - `["/dev/kvm"]` → `--device /dev/kvm`
   * - `["/dev/sda:/dev/xvda:rwm"]` → `--device /dev/sda:/dev/xvda:rwm`
   * - `["/dev/kvm", "/dev/fuse"]` → `--device /dev/kvm --device /dev/fuse`
   *
   * Under rootless Podman, exposing a host device often requires host-side
   * group/permission setup and may interact with `--userns=keep-id`.
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
   * Maps directly to `podman run --cpus`. Accepts fractional values:
   *
   * - `2` → `--cpus 2` (at most 2 CPUs)
   * - `1.5` → `--cpus 1.5` (at most 1.5 CPUs)
   *
   * When omitted, no `--cpus` flag is added and the container is unconstrained.
   */
  readonly cpus?: number;
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
      const usernsArgs =
        userns === false
          ? []
          : [`--userns=keep-id:uid=${containerUid},gid=${containerGid}`];
      const userArgs = ["--user", `${containerUid}:${containerGid}`];
      const network = options?.network;
      const networks =
        network === undefined || network === "" ? [] : [network].flat();
      const networkArgs = networks.flatMap((n) => ["--network", n]);
      const groupArgs = (options?.groups ?? []).flatMap((g) => [
        "--group-add",
        String(g),
      ]);
      const capDropArgs = (options?.capDrop ?? []).flatMap((cap) => [
        "--cap-drop",
        cap,
      ]);
      const deviceArgs = (options?.devices ?? []).flatMap((d) => [
        "--device",
        d,
      ]);
      const cpusArgs =
        options?.cpus === undefined ? [] : ["--cpus", String(options.cpus)];

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
            ...groupArgs,
            ...capDropArgs,
            ...deviceArgs,
            ...cpusArgs,
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

      // Register synchronous container cleanup via the shared shutdown registry
      // so concurrent sandboxes share a single exit/SIGINT/SIGTERM listener
      // instead of tripping Node's MaxListenersExceededWarning.
      // `--time 0`: PID 1 is `sleep infinity`, which ignores SIGTERM, so a
      // plain `rm -f` waits out the 10 s StopTimeout before SIGKILL. The 5 s
      // timeout below would kill that `rm` mid-stop and leave the container
      // in `Stopping` indefinitely.
      const removeContainerSync = () => {
        try {
          execFileSync("podman", ["rm", "-f", "--time", "0", containerName], {
            stdio: "ignore",
            timeout: 5000,
          });
        } catch {
          /* best-effort */
        }
      };
      const unregisterShutdown = registerShutdown(removeContainerSync);

      const handle: BindMountSandboxHandle = {
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
          const args = ["exec"];
          // Elevate by running as root through the engine, not a `sudo`
          // prefix: the image needs no sudo binary, and the whole command
          // (`a && b`, not just `a`) runs as root.
          if (opts?.sudo === true) {
            args.push("--user", "0:0");
          }
          if (opts?.stdin !== undefined) {
            args.push("-i");
          }
          if (opts?.cwd !== undefined && opts.cwd !== "") {
            args.push("-w", opts.cwd);
          }
          args.push(containerName, "sh", "-c", command);

          return new Promise((resolve, reject) => {
            const stdin = opts?.stdin;
            // Two literal `stdio` tuples, so the types know stdout and stderr
            // are always piped.
            const proc =
              stdin === undefined
                ? spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] })
                : spawn("podman", args, { stdio: ["pipe", "pipe", "pipe"] });

            if (stdin !== undefined) {
              proc.stdin?.write(stdin);
              proc.stdin?.end();
            }

            proc.on("error", (error: Error) => {
              reject(new Error(`podman exec failed: ${error.message}`));
            });

            if (opts?.onLine) {
              const { onLine } = opts;
              const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
              const stderrTail = new BoundedTail(maxOutputTailChars, "");
              const rl = createInterface({ input: proc.stdout });
              rl.on("line", (line) => {
                stdoutTail.push(line);
                onLine(line);
              });
              proc.stderr.on("data", (chunk: Buffer) => {
                stderrTail.push(chunk.toString());
              });
              proc.on("close", (code: number | null) => {
                resolve({
                  stdout: stdoutTail.toString(),
                  stderr: stderrTail.toString(),
                  exitCode: code ?? 0,
                });
              });
            } else {
              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];
              proc.stdout.on("data", (chunk: Buffer) => {
                stdoutChunks.push(chunk.toString());
              });
              proc.stderr.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });
              proc.on("close", (code: number | null) => {
                resolve({
                  stdout: stdoutChunks.join(""),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            }
          });
        },

        interactiveExec: async (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> =>
          new Promise((resolve, reject) => {
            const podmanArgs = ["exec"];
            // Allocate a pseudo-terminal when stdin looks like a TTY
            if (
              "isTTY" in opts.stdin &&
              (opts.stdin as { isTTY?: boolean }).isTTY === true
            ) {
              podmanArgs.push("-it");
            } else {
              podmanArgs.push("-i");
            }
            if (opts.cwd !== undefined && opts.cwd !== "") {
              podmanArgs.push("-w", opts.cwd);
            }
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
          }),
        copyFileIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> =>
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

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> =>
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
          unregisterShutdown();
          await new Promise<void>((resolve, reject) => {
            execFile(
              "podman",
              ["rm", "-f", "--time", "0", containerName],
              (error) => {
                if (error) {
                  reject(new Error(`podman rm failed: ${error.message}`));
                } else {
                  resolve();
                }
              },
            );
          });
        },
      };

      return handle;
    },
  });
};

// Re-export for backwards compatibility
export { defaultImageName } from "../mountUtils.js";

const checkImageExists = async (imageName: string): Promise<void> =>
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

const checkPodmanMachine = async (): Promise<void> =>
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
          const machines: unknown = JSON.parse(stdout);
          if (
            Array.isArray(machines) &&
            machines.some((m) => isRunningMachine(m))
          ) {
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

/** One entry of `podman machine list --format json` that reports it is running. */
const isRunningMachine = (machine: unknown): boolean =>
  typeof machine === "object" &&
  machine !== null &&
  "Running" in machine &&
  machine.Running === true;
