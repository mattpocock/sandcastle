import { Effect } from "effect";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { DockerError, ImageNotFoundError } from "./errors.js";
import { formatVolumeMount } from "./mountUtils.js";
import type { SelinuxLabel } from "./mountUtils.js";
import type { LinuxCapability } from "./LinuxCapability.js";

// Re-exported so docker.ts gets it with the lifecycle it already imports.
export type { LinuxCapability } from "./LinuxCapability.js";

const dockerExec = (args: string[]): Effect.Effect<string, DockerError> =>
  Effect.async((resume) => {
    execFile(
      "docker",
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new DockerError({
                message: `docker ${args[0]} failed: ${stderr || error.message}`,
              }),
            ),
          );
        } else {
          resume(Effect.succeed(stdout));
        }
      },
    );
  });

/**
 * Build the sandcastle Docker image.
 *
 * When `dockerfile` is provided, uses `docker build -f <dockerfile> <cwd>`
 * so COPY instructions resolve relative to the current working directory.
 * Otherwise, uses `docker build <dockerfileDir>` (the default .sandcastle/ directory).
 */
export const buildImage = (
  imageName: string,
  dockerfileDir: string,
  options?: {
    readonly dockerfile?: string;
    readonly buildArgs?: Record<string, string>;
  },
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    const buildArgFlags = Object.entries(options?.buildArgs ?? {}).flatMap(
      ([k, v]) => ["--build-arg", `${k}=${v}`],
    );
    const dockerfile = options?.dockerfile;
    const buildContext =
      dockerfile !== undefined && dockerfile !== ""
        ? ["-f", resolve(dockerfile), process.cwd()]
        : [resolve(dockerfileDir)];
    yield* dockerExec([
      "build",
      "-t",
      imageName,
      ...buildArgFlags,
      ...buildContext,
    ]);
  });

export interface VolumeMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly?: boolean;
}

export interface StartContainerOptions {
  readonly volumeMounts?: readonly VolumeMount[];
  readonly workdir?: string;
  /** Run the container as this uid:gid instead of the Dockerfile's USER. */
  readonly user?: string;
  /** Docker network(s) to attach the container to. Passed as `--network` flags. */
  readonly network?: string | readonly string[];
  /** Supplementary groups to add the container user to. Passed as `--group-add` flags. */
  readonly groups?: readonly (string | number)[];
  /** Linux capabilities to drop from the container. Passed as `--cap-drop` flags. */
  readonly capDrop?: readonly LinuxCapability[];
  /** Host devices to expose to the container. Passed as `--device` flags. */
  readonly devices?: readonly string[];
  /** Limit CPU resources via `--cpus` (e.g. `1.5`). Fractional values allowed. */
  readonly cpus?: number;
  /**
   * Limit container memory via `--memory` (e.g. `"2g"`, `"512m"`).
   * Also sets `--memory-swap` to the same value (hard cap, no swap headroom).
   */
  readonly memory?: string;
  /** Limit container process count via `--pids-limit` (e.g. `256`). */
  readonly pidsLimit?: number;
  /**
   * SELinux volume label suffix applied to bind mounts (default `"z"`).
   *
   * - `"z"` — shared label. No-op on non-SELinux systems.
   * - `"Z"` — private label; only this container can access the mount.
   * - `false` — disable labeling entirely.
   */
  readonly selinuxLabel?: SelinuxLabel;
}

/** Repeats `flag` before each value: `["--device", a, "--device", b]`. */
const repeatFlag = (
  flag: string,
  values: readonly (string | number)[] | undefined,
): string[] => (values ?? []).flatMap((value) => [flag, String(value)]);

/** `[flag, value]` when `value` is set and non-empty, else nothing. */
const optionalFlag = (flag: string, value: string | undefined): string[] =>
  value !== undefined && value !== "" ? [flag, value] : [];

/** The `docker run` flags for `env` and `options`, in the order docker gets them. */
const runFlags = (
  env: Record<string, string>,
  options: StartContainerOptions | undefined,
): string[] => {
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const network = options?.network;
  const networks =
    network === undefined || network === "" ? [] : [network].flat();
  return [
    ...repeatFlag(
      "-e",
      Object.entries(env).map(([k, v]) => `${k}=${v}`),
    ),
    ...repeatFlag(
      "-v",
      (options?.volumeMounts ?? []).map((mount) =>
        formatVolumeMount(mount, selinuxLabel),
      ),
    ),
    ...optionalFlag("-w", options?.workdir),
    ...optionalFlag("--user", options?.user),
    ...repeatFlag("--network", networks),
    ...repeatFlag("--group-add", options?.groups),
    ...repeatFlag("--cap-drop", options?.capDrop),
    ...repeatFlag("--device", options?.devices),
    ...(options?.cpus === undefined ? [] : ["--cpus", String(options.cpus)]),
    ...(options?.memory === undefined
      ? []
      : ["--memory", options.memory, "--memory-swap", options.memory]),
    ...(options?.pidsLimit === undefined
      ? []
      : ["--pids-limit", String(options.pidsLimit)]),
  ];
};

/**
 * Start a new container with environment variables injected.
 */
export const startContainer = (
  containerName: string,
  imageName: string,
  env: Record<string, string>,
  options?: StartContainerOptions,
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    // Check if container already exists
    const existing = yield* dockerExec([
      "ps",
      "-a",
      "--filter",
      `name=^${containerName}$`,
      "--format",
      "{{.Names}}",
    ]);

    if (existing.trim() === containerName) {
      return yield* new DockerError({
        message: `Container '${containerName}' already exists. Run cleanup first.`,
      });
    }

    return yield* dockerExec([
      "run",
      "-d",
      "--name",
      containerName,
      ...runFlags(env, options),
      imageName,
    ]).pipe(Effect.asVoid);
  });

/**
 * Stop and remove a container without removing the image.
 */
export const removeContainer = (
  containerName: string,
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    // Stop container (ignore errors if already stopped)
    yield* Effect.ignore(dockerExec(["stop", containerName]));
    // Remove container (ignore errors if not found)
    yield* Effect.ignore(dockerExec(["rm", containerName]));
  });

/**
 * Remove a Docker image.
 */
export const removeImage = (
  imageName: string,
): Effect.Effect<void, DockerError | ImageNotFoundError> =>
  dockerExec(["rmi", imageName]).pipe(
    Effect.asVoid,
    Effect.catchTag(
      "DockerError",
      (error): Effect.Effect<never, DockerError | ImageNotFoundError> =>
        error.message.includes("No such image")
          ? Effect.fail(
              new ImageNotFoundError({
                message: `Docker image '${imageName}' does not exist, so there is nothing to remove.`,
              }),
            )
          : Effect.fail(error),
    ),
  );
