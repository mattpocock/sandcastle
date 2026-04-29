import { Effect } from "effect";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { DockerError } from "./errors.js";

export interface DockerCommandOptions {
  /** Docker context to run commands against. Uses Docker's active context when omitted. */
  readonly context?: string;
}

export const dockerArgs = (
  args: readonly string[],
  options?: DockerCommandOptions,
): string[] =>
  options?.context ? ["--context", options.context, ...args] : [...args];

const dockerExec = (
  args: string[],
  options?: DockerCommandOptions,
): Effect.Effect<string, DockerError> =>
  Effect.async((resume) => {
    execFile(
      "docker",
      dockerArgs(args, options),
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
  options?: { readonly dockerfile?: string } & DockerCommandOptions,
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    if (options?.dockerfile) {
      yield* dockerExec(
        [
          "build",
          "-t",
          imageName,
          "-f",
          resolve(options.dockerfile),
          process.cwd(),
        ],
        options,
      );
    } else {
      yield* dockerExec(
        ["build", "-t", imageName, resolve(dockerfileDir)],
        options,
      );
    }
  });

export interface StartContainerOptions {
  readonly volumeMounts?: readonly string[];
  readonly workdir?: string;
  /** Run the container as this uid:gid instead of the Dockerfile's USER. */
  readonly user?: string;
  /** Docker network(s) to attach the container to. Passed as `--network` flags. */
  readonly network?: string | readonly string[];
  /** Docker context to run commands against. Uses Docker's active context when omitted. */
  readonly context?: string;
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
    const existing = yield* dockerExec(
      [
        "ps",
        "-a",
        "--filter",
        `name=^${containerName}$`,
        "--format",
        "{{.Names}}",
      ],
      options,
    );

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

    const volumeFlags = (options?.volumeMounts ?? []).flatMap((mount) => [
      "-v",
      mount,
    ]);

    const workdirFlags = options?.workdir ? ["-w", options.workdir] : [];
    const userFlags = options?.user ? ["--user", options.user] : [];
    const networks = options?.network
      ? Array.isArray(options.network)
        ? options.network
        : [options.network]
      : [];
    const networkFlags = networks.flatMap((n) => ["--network", n]);

    yield* dockerExec(
      [
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
      ],
      options,
    );
  });

/**
 * Stop and remove a container without removing the image.
 */
export const removeContainer = (
  containerName: string,
  options?: DockerCommandOptions,
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    // Stop container (ignore errors if already stopped)
    yield* Effect.ignore(dockerExec(["stop", containerName], options));
    // Remove container (ignore errors if not found)
    yield* Effect.ignore(dockerExec(["rm", containerName], options));
  });

/**
 * Remove a Docker image.
 */
export const removeImage = (
  imageName: string,
  options?: DockerCommandOptions,
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    yield* dockerExec(["rmi", imageName], options);
  });
