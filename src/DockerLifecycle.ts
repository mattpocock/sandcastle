import { Effect } from "effect";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { DockerError } from "./errors.js";
import { formatVolumeMount, type SelinuxLabel } from "./mountUtils.js";

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
                message: `docker ${args[0]} failed: ${stderr?.toString() || error.message}`,
              }),
            ),
          );
        } else {
          resume(Effect.succeed(stdout.toString()));
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
    if (options?.dockerfile) {
      yield* dockerExec([
        "build",
        "-t",
        imageName,
        ...buildArgFlags,
        "-f",
        resolve(options.dockerfile),
        process.cwd(),
      ]);
    } else {
      yield* dockerExec([
        "build",
        "-t",
        imageName,
        ...buildArgFlags,
        resolve(dockerfileDir),
      ]);
    }
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
  /**
   * SELinux volume label suffix applied to bind mounts (default `"z"`).
   *
   * - `"z"` — shared label. No-op on non-SELinux systems.
   * - `"Z"` — private label; only this container can access the mount.
   * - `false` — disable labeling entirely.
   */
  readonly selinuxLabel?: SelinuxLabel;
}

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
      yield* Effect.fail(
        new DockerError({
          message: `Container '${containerName}' already exists. Run cleanup first.`,
        }),
      );
    }

    const envFlags = Object.entries(env).flatMap(([k, v]) => [
      "-e",
      `${k}=${v}`,
    ]);

    const selinuxLabel = options?.selinuxLabel ?? "z";
    const volumeFlags = (options?.volumeMounts ?? []).flatMap((mount) => [
      "-v",
      formatVolumeMount(mount, selinuxLabel),
    ]);

    const workdirFlags = options?.workdir ? ["-w", options.workdir] : [];
    const userFlags = options?.user ? ["--user", options.user] : [];
    const networks = options?.network
      ? Array.isArray(options.network)
        ? options.network
        : [options.network]
      : [];
    const networkFlags = networks.flatMap((n) => ["--network", n]);

    yield* dockerExec([
      "run",
      "-d",
      "--name",
      containerName,
      ...envFlags,
      ...volumeFlags,
      ...workdirFlags,
      ...userFlags,
      ...networkFlags,
      imageName,
    ]);
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
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    yield* dockerExec(["rmi", imageName]);
  });
