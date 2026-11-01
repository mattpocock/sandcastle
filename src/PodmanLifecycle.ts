import { Effect } from "effect";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { PodmanError, ImageNotFoundError } from "./errors.js";

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
                message: `podman ${args[0]} failed: ${stderr || error.message}`,
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
    const containerfile = options?.containerfile;
    const buildContext =
      containerfile !== undefined && containerfile !== ""
        ? ["-f", resolve(containerfile), process.cwd()]
        : [resolve(containerfileDir)];
    yield* podmanExec(["build", "-t", imageName, ...buildContext]);
  });

/**
 * Remove a Podman image.
 */
export const removeImage = (
  imageName: string,
): Effect.Effect<void, PodmanError | ImageNotFoundError> =>
  podmanExec(["rmi", imageName]).pipe(
    Effect.asVoid,
    Effect.catchTag(
      "PodmanError",
      (error): Effect.Effect<never, PodmanError | ImageNotFoundError> =>
        error.message.includes("image not known")
          ? Effect.fail(
              new ImageNotFoundError({
                message: `Podman image '${imageName}' does not exist, so there is nothing to remove.`,
              }),
            )
          : Effect.fail(error),
    ),
  );
