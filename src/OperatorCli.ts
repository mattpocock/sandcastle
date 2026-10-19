import { loadEnvironmentConfigEffect } from "./OperatorEnvironment.js";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { execFile, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { defaultImageName } from "./sandboxes/docker.js";
import { OperatorError } from "./Operator.js";
import type { OperatorProjectAdapter } from "./OperatorServer.js";
import { registerShutdown } from "./shutdownRegistry.js";

/** Fixed reviewed-workflow adapter for the CLI. Paths/commands are project-owned, never editable HTTP fields. */
export const operatorCliAdapter = (project: string): OperatorProjectAdapter => {
  const cwd = resolve(project);
  const promptFiles = {
    planner: ".sandcastle/plan-prompt.md",
    implementer: ".sandcastle/implement-prompt.md",
    reviewer: ".sandcastle/review-prompt.md",
    merger: ".sandcastle/merge-prompt.md",
    readiness: ".sandcastle/readiness-prompt.md",
  };
  return {
    promptFiles,
    sandboxIdentity: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const environment = yield* loadEnvironmentConfigEffect(cwd);
          const docker = yield* fs.exists(resolve(cwd, environment.dockerfile));
          const podman = yield* fs.exists(
            join(cwd, ".sandcastle", "Containerfile"),
          );
          if (docker === podman)
            return yield* Effect.fail(
              new OperatorError({
                message:
                  "Expected one Dockerfile or Containerfile; use an SDK project adapter for custom sandboxes",
              }),
            );
          const image = docker ? environment.image : defaultImageName(cwd);
          return yield* Effect.async<string, OperatorError>((resume) => {
            execFile(
              docker ? "docker" : "podman",
              ["image", "inspect", image, "--format", "{{.Id}}"],
              { cwd, encoding: "utf8", timeout: 30_000 },
              (error, stdout) => {
                if (error || !/^sha256:[a-f0-9]{64}$/.test(stdout.trim()))
                  resume(
                    Effect.fail(
                      new OperatorError({
                        message:
                          "Cannot resolve the project's sandbox image; build it with sandcastle docker/podman build-image first",
                      }),
                    ),
                  );
                else resume(Effect.succeed(stdout.trim()));
              },
            );
          });
        }).pipe(
          Effect.mapError((error) =>
            error instanceof OperatorError
              ? error
              : new OperatorError({
                  message: "Cannot read project sandbox configuration",
                }),
          ),
          Effect.provide(NodeFileSystem.layer),
        ),
      ),
    run: (runtime) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const candidates = ["main.ts", "main.mts"];
          const existing: string[] = [];
          for (const name of candidates)
            if (yield* fs.exists(join(cwd, ".sandcastle", name)))
              existing.push(name);
          if (existing.length !== 1)
            return yield* Effect.fail(
              new OperatorError({
                message:
                  "Expected one .sandcastle/main.ts or main.mts reviewed workflow",
              }),
            );
          const path = join(cwd, ".sandcastle", existing[0]!);
          const content = yield* fs.readFileString(path);
          if (!content.includes("sandcastle.openProjectRuntime"))
            return yield* Effect.fail(
              new OperatorError({
                message:
                  "This workflow does not consume frozen role configuration; initialize a new reviewed Codex workflow or adopt the shared runtime SDK",
              }),
            );
          yield* Effect.async<void, OperatorError>((resume) => {
            const child = spawn(process.execPath, ["--import", "tsx", path], {
              cwd,
              stdio: "inherit",
              env: { ...process.env, SANDCASTLE_RUNTIME_ID: runtime.record.id },
            });
            const unregister = registerShutdown(() => child.kill("SIGTERM"));
            child.once("error", () => {
              unregister();
              resume(
                Effect.fail(
                  new OperatorError({
                    message:
                      "Cannot start project workflow; install its tsx dependency",
                  }),
                ),
              );
            });
            child.once("exit", (code) => {
              unregister();
              resume(
                code === 0
                  ? Effect.void
                  : Effect.fail(
                      new OperatorError({
                        message:
                          "Project workflow failed; inspect its recorded run and host output",
                      }),
                    ),
              );
            });
          });
        }).pipe(
          Effect.mapError((error) =>
            error instanceof OperatorError
              ? error
              : new OperatorError({
                  message: "Cannot execute project workflow",
                }),
          ),
          Effect.provide(NodeFileSystem.layer),
        ),
      ),
  };
};
