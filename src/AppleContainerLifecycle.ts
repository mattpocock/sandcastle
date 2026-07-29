import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { Effect } from "effect";
import { AppleContainerError } from "./errors.js";

const containerExec = (
  args: string[],
): Effect.Effect<string, AppleContainerError> =>
  Effect.async((resume) => {
    execFile(
      "container",
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new AppleContainerError({
                message: `container ${args[0]} failed: ${stderr?.toString() || error.message}`,
              }),
            ),
          );
        } else {
          resume(Effect.succeed(stdout.toString()));
        }
      },
    );
  });

export const buildImage = (
  imageName: string,
  dockerfileDir: string,
  options?: {
    readonly dockerfile?: string;
    readonly buildArgs?: Readonly<Record<string, string>>;
  },
): Effect.Effect<void, AppleContainerError> =>
  Effect.gen(function* () {
    const buildArgs = Object.entries(options?.buildArgs ?? {}).flatMap(
      ([key, value]) => ["--build-arg", `${key}=${value}`],
    );

    if (options?.dockerfile) {
      yield* containerExec([
        "build",
        "-t",
        imageName,
        ...buildArgs,
        "-f",
        resolve(options.dockerfile),
        process.cwd(),
      ]);
    } else {
      yield* containerExec([
        "build",
        "-t",
        imageName,
        ...buildArgs,
        resolve(dockerfileDir),
      ]);
    }
  });

export const removeImage = (
  imageName: string,
): Effect.Effect<void, AppleContainerError> =>
  Effect.gen(function* () {
    yield* containerExec(["image", "delete", imageName]);
  });
