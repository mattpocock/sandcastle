import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
  type InteractiveExecOptions,
  type SandboxProvider,
} from "../SandboxProvider.js";
import type { MountConfig } from "../MountConfig.js";
import { defaultImageName, resolveUserMounts } from "../mountUtils.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import { registerShutdown } from "../shutdownRegistry.js";

export interface AppleContainerOptions {
  /** Image name (default: derived from the repository directory name). */
  readonly imageName?: string;
  /** UID of the `agent` user in the image (default: host UID, or 1000). */
  readonly containerUid?: number;
  /** GID of the `agent` user in the image (default: host GID, or 1000). */
  readonly containerGid?: number;
  /** Additional host paths to bind-mount into the sandbox. */
  readonly mounts?: readonly MountConfig[];
  /** Environment variables injected by this provider. */
  readonly env?: Record<string, string>;
  /** Apple Container network to attach the sandbox to. */
  readonly network?: string;
  /** Number of CPUs allocated to the sandbox microVM. */
  readonly cpus?: number;
  /** Memory allocated to the sandbox microVM, such as `"4G"`. */
  readonly memory?: string;
  /** Forward the host SSH agent with Apple Container's native `--ssh` support. */
  readonly ssh?: boolean;
  /** Maximum retained stdout and stderr tail per streamed command. */
  readonly maxOutputTailChars?: number;
}

export const appleContainer = (
  options?: AppleContainerOptions,
): SandboxProvider => {
  const configuredImageName = options?.imageName;
  const containerUid = options?.containerUid ?? process.getuid?.() ?? 1000;
  const containerGid = options?.containerGid ?? process.getgid?.() ?? 1000;
  const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
  const sandboxHomedir = "/home/agent";
  const userMounts = options?.mounts
    ? resolveUserMounts(options.mounts, sandboxHomedir)
    : [];
  const nonDirectoryMount = userMounts.find(
    (mount) => !statSync(mount.hostPath).isDirectory(),
  );
  if (nonDirectoryMount) {
    throw new Error(
      `Apple Container bind mounts require directory host paths; '${nonDirectoryMount.hostPath}' is not a directory. Mount a dedicated parent directory instead.`,
    );
  }
  userMounts.forEach(validateMountSpec);

  return createBindMountSandboxProvider({
    name: "apple-container",
    env: options?.env,
    sandboxHomedir,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      await checkSystemAvailable();

      const containerName = `sandcastle-${randomUUID()}`;
      const worktreePath =
        createOptions.mounts.find(
          (mount) => mount.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? "/home/agent/workspace";
      const imageName =
        configuredImageName ?? defaultImageName(createOptions.hostRepoPath);
      const mounts = resolveAppleContainerMounts(
        [...createOptions.mounts, ...userMounts],
        createOptions.worktreePath,
      );

      await checkImageIdentity(imageName, containerUid, containerGid);

      const env = { ...createOptions.env, HOME: sandboxHomedir };
      const envArgs = Object.entries(env).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]);
      const mountArgs = mounts.flatMap((mount) => [
        "--mount",
        [
          `source=${mount.hostPath}`,
          `target=${mount.sandboxPath}`,
          mount.readonly ? "readonly" : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join(","),
      ]);
      const networkArgs = options?.network
        ? ["--network", options.network]
        : [];
      const cpuArgs =
        options?.cpus === undefined ? [] : ["--cpus", String(options.cpus)];
      const memoryArgs = options?.memory ? ["--memory", options.memory] : [];
      const sshArgs = options?.ssh ? ["--ssh"] : [];

      await new Promise<void>((resolve, reject) => {
        execFile(
          "container",
          [
            "run",
            "--detach",
            "--name",
            containerName,
            "--user",
            `${containerUid}:${containerGid}`,
            "--workdir",
            worktreePath,
            ...networkArgs,
            ...cpuArgs,
            ...memoryArgs,
            ...sshArgs,
            ...envArgs,
            ...mountArgs,
            "--entrypoint",
            "sleep",
            imageName,
            "infinity",
          ],
          (error) => {
            if (error) {
              reject(new Error(`Apple Container run failed: ${error.message}`));
            } else {
              resolve();
            }
          },
        );
      });

      const removeContainerSync = () => {
        try {
          execFileSync("container", ["delete", "--force", containerName], {
            stdio: "ignore",
            timeout: 5000,
          });
        } catch {}
      };
      const unregisterShutdown = registerShutdown(removeContainerSync);

      return {
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
          if (opts?.stdin !== undefined) args.push("--interactive");
          if (opts?.cwd) args.push("--workdir", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);

          return new Promise((resolve, reject) => {
            const proc = spawn("container", args, {
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
              reject(
                new Error(`Apple Container exec failed: ${error.message}`),
              );
            });

            if (opts?.onLine) {
              const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
              const stderrTail = new BoundedTail(maxOutputTailChars, "");
              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutTail.push(line);
                opts.onLine!(line);
              });
              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrTail.push(chunk.toString());
              });
              proc.on("close", (code, signal) => {
                resolve({
                  stdout: stdoutTail.toString(),
                  stderr: stderrTail.toString(),
                  exitCode: resolveExitCode(code, signal),
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
              proc.on("close", (code, signal) => {
                resolve({
                  stdout: stdoutChunks.join(""),
                  stderr: stderrChunks.join(""),
                  exitCode: resolveExitCode(code, signal),
                });
              });
            }
          });
        },

        interactiveExec: (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> =>
          new Promise((resolve, reject) => {
            const containerArgs = ["exec", "--interactive"];
            if (
              "isTTY" in opts.stdin &&
              (opts.stdin as { isTTY?: boolean }).isTTY
            ) {
              containerArgs.push("--tty");
            }
            if (opts.cwd) containerArgs.push("--workdir", opts.cwd);
            containerArgs.push(containerName, ...args);

            const proc = spawn("container", containerArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            });
            proc.on("error", (error: Error) => {
              reject(
                new Error(`Apple Container exec failed: ${error.message}`),
              );
            });
            proc.on("close", (code: number | null, signal) => {
              resolve({ exitCode: resolveExitCode(code, signal) });
            });
          }),

        copyFileIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const proc = spawn(
            "container",
            [
              "exec",
              "--interactive",
              "--user",
              `${containerUid}:${containerGid}`,
              containerName,
              "sh",
              "-c",
              'mkdir -p "$(dirname "$1")" && cat > "$1"',
              "sh",
              sandboxPath,
            ],
            { stdio: ["pipe", "ignore", "pipe"] },
          );
          const stderr = collectStderr(proc);
          const completion = waitForExit(proc);

          try {
            const [exitCode] = await Promise.all([
              completion,
              pipeline(createReadStream(hostPath), proc.stdin!),
            ]);
            if (exitCode !== 0) {
              throw new Error(stderr.toString().trim() || `exit ${exitCode}`);
            }
          } catch (error) {
            proc.kill();
            await completion.catch(() => undefined);
            throw new Error(
              `Apple Container copy (in) failed: ${copyFailureDetail(stderr, error)}`,
            );
          }
        },

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          const hostDir = dirname(hostPath);
          const tempHostPath = join(
            hostDir,
            `.${basename(hostPath)}.sandcastle-${randomUUID()}.tmp`,
          );
          await mkdir(hostDir, { recursive: true });

          const proc = spawn(
            "container",
            [
              "exec",
              "--user",
              `${containerUid}:${containerGid}`,
              containerName,
              "sh",
              "-c",
              'cat "$1"',
              "sh",
              sandboxPath,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          const stderr = collectStderr(proc);
          const completion = waitForExit(proc);

          try {
            const [exitCode] = await Promise.all([
              completion,
              pipeline(proc.stdout!, createWriteStream(tempHostPath)),
            ]);
            if (exitCode !== 0) {
              throw new Error(stderr.toString().trim() || `exit ${exitCode}`);
            }
            await rename(tempHostPath, hostPath);
          } catch (error) {
            proc.kill();
            await completion.catch(() => undefined);
            await rm(tempHostPath, { force: true }).catch(() => undefined);
            throw new Error(
              `Apple Container copy (out) failed: ${copyFailureDetail(stderr, error)}`,
            );
          }
        },

        close: async (): Promise<void> => {
          unregisterShutdown();
          await deleteContainer(containerName);
        },
      };
    },
  });
};

export { defaultImageName };

const checkSystemAvailable = (): Promise<void> => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return Promise.reject(
      new Error("Apple Container requires macOS on Apple silicon."),
    );
  }

  return new Promise((resolve, reject) => {
    execFile("container", ["system", "status"], (error, _stdout, stderr) => {
      if (!error) {
        resolve();
      } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "Apple Container CLI was not found on PATH. Install Apple Container before creating a sandbox.",
          ),
        );
      } else {
        reject(
          new Error(
            `Apple Container services are unavailable: ${stderr?.toString().trim() || error.message}. Run 'container system start' first. For a noninteractive first start, use 'container system start --enable-kernel-install'.`,
          ),
        );
      }
    });
  });
};

const asRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
};

const optionalString = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${path}.${key} must be a string`);
  }
  return value;
};

const parseAppleImageVariants = (
  value: unknown,
): Array<{ architecture?: string; user?: string }> => {
  if (!Array.isArray(value)) {
    throw new Error("image inspect output must be an array");
  }

  return value.flatMap((rawImage, imageIndex) => {
    const image = asRecord(rawImage, `images[${imageIndex}]`);
    if (!Array.isArray(image.variants)) {
      throw new Error(`images[${imageIndex}].variants must be an array`);
    }

    return image.variants.map((rawVariant, variantIndex) => {
      const path = `images[${imageIndex}].variants[${variantIndex}]`;
      const variant = asRecord(rawVariant, path);
      const config = asRecord(variant.config, `${path}.config`);
      const ociConfig = asRecord(config.config, `${path}.config.config`);
      const platform =
        variant.platform === undefined
          ? undefined
          : asRecord(variant.platform, `${path}.platform`);

      return {
        architecture:
          (platform
            ? optionalString(platform, "architecture", `${path}.platform`)
            : undefined) ??
          optionalString(config, "architecture", `${path}.config`),
        user: optionalString(ociConfig, "User", `${path}.config.config`),
      };
    });
  });
};

const checkImageIdentity = (
  imageName: string,
  expectedUid: number,
  expectedGid: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(
      "container",
      ["image", "inspect", imageName],
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Image '${imageName}' is unavailable locally: ${stderr?.toString().trim() || error.message}. Build it with 'sandcastle apple-container build-image'.`,
            ),
          );
          return;
        }

        try {
          const variants = parseAppleImageVariants(
            JSON.parse(stdout.toString()) as unknown,
          );
          const variant =
            variants.find(
              (candidate) => candidate.architecture === process.arch,
            ) ?? (variants.length === 1 ? variants[0] : undefined);

          if (!variant) {
            reject(
              new Error(
                `Image '${imageName}' has no '${process.arch}' variant. Rebuild it with 'sandcastle apple-container build-image'.`,
              ),
            );
            return;
          }

          const imageUser = variant.user?.trim();
          if (!imageUser) {
            resolve();
            return;
          }

          const [uidPart, gidPart] = imageUser.split(":", 2);
          const imageUid = Number.parseInt(uidPart!, 10);
          const imageGid =
            gidPart === undefined ? undefined : Number.parseInt(gidPart, 10);
          const uidMismatch =
            Number.isFinite(imageUid) && imageUid !== expectedUid;
          const gidMismatch =
            imageGid !== undefined &&
            Number.isFinite(imageGid) &&
            imageGid !== expectedGid;

          if (uidMismatch || gidMismatch) {
            reject(
              new Error(
                `Image identity mismatch: image '${imageName}' was built with user '${imageUser}', but Apple Container is configured to run as '${expectedUid}:${expectedGid}'. Rebuild it with 'sandcastle apple-container build-image', or set containerUid and containerGid in appleContainer() to match the image.`,
              ),
            );
            return;
          }

          resolve();
        } catch (parseError) {
          reject(
            new Error(
              `Apple Container returned unexpected metadata for image '${imageName}': ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          );
        }
      },
    );
  });

const deleteContainer = (containerName: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("container", ["delete", "--force", containerName], (error) => {
      if (error) {
        reject(new Error(`Apple Container delete failed: ${error.message}`));
      } else {
        resolve();
      }
    });
  });

const collectStderr = (proc: ChildProcess): BoundedTail => {
  const stderr = new BoundedTail(MAX_TAIL_CHARS, "");
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString());
  });
  return stderr;
};

const waitForExit = (proc: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code ?? 1));
  });

const resolveExitCode = (
  code: number | null,
  signal: NodeJS.Signals | null,
): number => code ?? (signal === null ? 0 : 1);

const copyFailureDetail = (stderr: BoundedTail, error: unknown): string =>
  stderr.toString().trim() ||
  (error instanceof Error ? error.message : String(error));

const validateMountSpec = (mount: MountConfig): void => {
  for (const [kind, path] of [
    ["source", mount.hostPath],
    ["target", mount.sandboxPath],
  ] as const) {
    if (/[=,]/.test(path)) {
      throw new Error(
        `Apple Container cannot represent mount ${kind} path '${path}' because it contains ',' or '='. Move the directory to a path without those characters.`,
      );
    }
  }
};

const resolveAppleContainerMounts = (
  mounts: MountConfig[],
  worktreePath: string,
): MountConfig[] => {
  const worktreeGitPath = resolve(worktreePath, ".git");
  const gitPointerDirectories = mounts
    .filter(
      (mount) =>
        !statSync(mount.hostPath).isDirectory() &&
        basename(mount.hostPath) === ".git",
    )
    .map((mount) => dirname(mount.hostPath));
  const directoryMounts = mounts.filter((mount) => {
    if (statSync(mount.hostPath).isDirectory()) return true;
    if (
      resolve(mount.hostPath) === worktreeGitPath ||
      basename(mount.hostPath) === ".git"
    ) {
      return false;
    }
    throw new Error(
      `Apple Container bind mounts require directory host paths; '${mount.hostPath}' is not a directory. Mount a dedicated parent directory instead.`,
    );
  });
  const resolvedMounts: MountConfig[] = [];
  const mountsByTarget = new Map<string, MountConfig>();
  const addMount = (mount: MountConfig): void => {
    validateMountSpec(mount);
    const existing = mountsByTarget.get(mount.sandboxPath);
    if (!existing) {
      mountsByTarget.set(mount.sandboxPath, mount);
      resolvedMounts.push(mount);
      return;
    }

    if (
      realpathSync(existing.hostPath) === realpathSync(mount.hostPath) &&
      Boolean(existing.readonly) === Boolean(mount.readonly)
    ) {
      return;
    }

    throw new Error(
      `Apple Container mount target '${mount.sandboxPath}' is configured more than once for '${existing.hostPath}' and '${mount.hostPath}'. Use one source per sandbox path.`,
    );
  };

  directoryMounts.forEach(addMount);
  const gitPointerMounts = gitPointerDirectories.map((hostPath) => ({
    hostPath,
    sandboxPath: hostPath,
    readonly: true,
  }));
  gitPointerMounts.forEach(addMount);

  for (const mount of [...directoryMounts, ...gitPointerMounts]) {
    if (mount.sandboxPath !== mount.hostPath) continue;
    const canonicalPath = realpathSync(mount.hostPath);
    if (canonicalPath === mount.sandboxPath) continue;

    const existing = mountsByTarget.get(canonicalPath);
    if (existing) {
      if (realpathSync(existing.hostPath) !== canonicalPath) {
        throw new Error(
          `Apple Container mount target '${canonicalPath}' is required for '${mount.hostPath}' but is already configured for '${existing.hostPath}'.`,
        );
      }
      continue;
    }

    addMount({ ...mount, sandboxPath: canonicalPath });
  }

  if (existsSync(worktreeGitPath) && statSync(worktreeGitPath).isFile()) {
    const canonicalWorktreePath = realpathSync(worktreePath);
    const existing = mountsByTarget.get(canonicalWorktreePath);
    if (existing) {
      if (
        realpathSync(existing.hostPath) !== canonicalWorktreePath &&
        realpathSync(existing.hostPath) !== realpathSync(worktreePath)
      ) {
        throw new Error(
          `Apple Container mount target '${canonicalWorktreePath}' is required for the Git worktree but is already configured for '${existing.hostPath}'.`,
        );
      }
      return resolvedMounts;
    }

    addMount({
      hostPath: worktreePath,
      sandboxPath: canonicalWorktreePath,
      readonly: true,
    });
  }

  return resolvedMounts;
};
