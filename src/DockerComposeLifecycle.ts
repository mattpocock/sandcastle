import { Effect } from "effect";
import { execFile } from "node:child_process";
import { DockerError } from "./errors.js";

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
                message:
                  `docker ${args[0]} ${args[1] ?? ""} failed: ${stderr?.toString() || error.message}`.trim(),
              }),
            ),
          );
        } else {
          resume(Effect.succeed(stdout.toString()));
        }
      },
    );
  });

export interface VolumeMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly?: boolean;
}

export interface ComposeStartContainerOptions {
  readonly volumeMounts?: readonly VolumeMount[];
  readonly workdir?: string;
  /** Path to the compose file. When omitted, docker compose auto-discovers from projectDirectory. */
  readonly composeFile?: string;
  /** Project directory passed to `docker compose --project-directory`. */
  readonly projectDirectory?: string;
  /** Compose project name. When omitted, docker compose derives it from the project directory. */
  readonly projectName?: string;
}

const composeBaseArgs = (options?: ComposeStartContainerOptions): string[] => {
  const args = ["compose"];
  if (options?.composeFile) args.push("-f", options.composeFile);
  if (options?.projectDirectory)
    args.push("--project-directory", options.projectDirectory);
  if (options?.projectName) args.push("-p", options.projectName);
  return args;
};

/**
 * Start a one-off container for a compose service in detached mode.
 *
 * Equivalent to `docker compose run -d --name <containerName> ...flags <serviceName>`.
 * Image, networks, GPU reservations, and dependent services come from the compose file —
 * sandcastle only injects the per-run worktree mount, workdir, and env.
 */
export const startContainer = (
  containerName: string,
  serviceName: string,
  env: Record<string, string>,
  options?: ComposeStartContainerOptions,
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
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

    // docker compose run does not accept --mount (unlike docker run); use -v.
    // On Windows, drive letters are recognised so `C:\path:/sandbox/path` parses
    // correctly — the second colon is the separator.
    const volumeFlags = (options?.volumeMounts ?? []).flatMap((mount) => [
      "-v",
      `${mount.hostPath}:${mount.sandboxPath}${mount.readonly ? ":ro" : ""}`,
    ]);

    const workdirFlags = options?.workdir ? ["--workdir", options.workdir] : [];

    yield* dockerExec([
      ...composeBaseArgs(options),
      "run",
      "-d",
      "--name",
      containerName,
      ...envFlags,
      ...volumeFlags,
      ...workdirFlags,
      serviceName,
    ]);
  });

/**
 * Stop and remove a container previously started by `docker compose run`.
 *
 * Uses plain `docker stop`/`docker rm` rather than `docker compose rm` because
 * the container is named explicitly via `--name` and we don't need the compose
 * project context for teardown.
 */
export const removeContainer = (
  containerName: string,
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    yield* Effect.ignore(dockerExec(["stop", containerName]));
    yield* Effect.ignore(dockerExec(["rm", containerName]));
  });
