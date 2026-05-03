import { Effect } from "effect";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { PodmanError } from "./errors.js";

const podmanExec = (args: string[]): Effect.Effect<string, PodmanError> =>
  Effect.async((resume) => {
    execFile(
      "podman",
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new PodmanError({
                message: `podman ${args[0]} failed: ${stderr?.toString() || error.message}`,
              }),
            ),
          );
        } else {
          resume(Effect.succeed(stdout.toString()));
        }
      },
    );
  });

export type PodmanHealth = "ok" | "not-installed" | "not-running";

/**
 * Probe whether the podman CLI is on PATH and the machine/daemon is reachable.
 *
 * Returns "not-installed" if the binary is missing, "not-running" if the
 * machine is unreachable, "ok" otherwise.
 */
export const checkPodmanHealth: Effect.Effect<PodmanHealth> = Effect.async(
  (resume) => {
    execFile(
      "podman",
      ["info", "--format", "{{.Version.Version}}"],
      { maxBuffer: 1024 * 1024 },
      (error) => {
        if (!error) {
          resume(Effect.succeed("ok"));
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          resume(Effect.succeed("not-installed"));
          return;
        }
        resume(Effect.succeed("not-running"));
      },
    );
  },
);

/**
 * Build the sandcastle Podman image.
 *
 * When `containerfile` is provided, uses `podman build -f <containerfile> <cwd>`
 * so COPY instructions resolve relative to the current working directory.
 * Otherwise, uses `podman build <containerfileDir>` (the default .sandcastle/ directory).
 */
export const buildImage = (
  imageName: string,
  containerfileDir: string,
  options?: { readonly containerfile?: string },
): Effect.Effect<void, PodmanError> =>
  Effect.gen(function* () {
    if (options?.containerfile) {
      yield* podmanExec([
        "build",
        "-t",
        imageName,
        "-f",
        resolve(options.containerfile),
        process.cwd(),
      ]);
    } else {
      yield* podmanExec(["build", "-t", imageName, resolve(containerfileDir)]);
    }
  });

/**
 * Remove a Podman image.
 */
export const removeImage = (
  imageName: string,
): Effect.Effect<void, PodmanError> =>
  Effect.gen(function* () {
    yield* podmanExec(["rmi", imageName]);
  });
