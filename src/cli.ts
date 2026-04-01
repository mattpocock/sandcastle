import { Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import * as clack from "@clack/prompts";
import { execSync, spawn } from "node:child_process";
import { join } from "node:path";
import { styleText } from "node:util";
import { Display } from "./Display.js";

import { buildImage, removeImage } from "./DockerLifecycle.js";
import { scaffold, listTemplates, getNextStepsLines } from "./InitService.js";
import { defaultImageName, DEFAULT_AGENT } from "./run.js";
import { getAgentProvider } from "./AgentProvider.js";
import { AgentError, ConfigDirError, InitError } from "./errors.js";
import type { AgentProvider } from "./AgentProvider.js";
import {
  SandboxFactory,
  WorktreeDockerSandboxFactory,
  WorktreeSandboxConfig,
  SANDBOX_WORKSPACE_DIR,
} from "./SandboxFactory.js";
import { withSandboxLifecycle } from "./SandboxLifecycle.js";
import { resolveEnv } from "./EnvResolver.js";

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const resolveImageName = (
  cliFlag: import("effect").Option.Option<string>,
  cwd: string,
): string => (cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd));

const agentOption = Options.text("agent").pipe(
  Options.withDescription('Agent provider to use (e.g. "claude-code", "pi")'),
  Options.withDefault(DEFAULT_AGENT),
);

// --- Config directory check ---

const CONFIG_DIR = ".sandcastle";

const requireConfigDir = (
  cwd: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(join(cwd, CONFIG_DIR))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      yield* Effect.fail(
        new ConfigDirError({
          message: "No .sandcastle/ found. Run `sandcastle init` first.",
        }),
      );
    }
  });

// --- Init command ---

const templateOption = Options.text("template").pipe(
  Options.withDescription(
    "Template to scaffold (e.g. blank, simple-loop, parallel-planner)",
  ),
  Options.optional,
);

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
  },
  ({ imageName: imageNameFlag, template, agent }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag, cwd);

      const agentName = agent;
      const provider = yield* Effect.try({
        try: () => getAgentProvider(agentName),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      // Resolve template: CLI flag > interactive select
      const templates = listTemplates();
      let selectedTemplate: string;
      if (template._tag === "Some") {
        const t = template.value;
        const valid = templates.find((tmpl) => tmpl.name === t);
        if (!valid) {
          const names = templates.map((tmpl) => tmpl.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown template "${t}". Available: ${names}`,
            }),
          );
        }
        selectedTemplate = t;
      } else {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a template:",
            initialValue: "blank",
            options: templates.map((tmpl) => ({
              value: tmpl.name,
              label: tmpl.name,
              hint: tmpl.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Template selection cancelled." }),
          );
        }
        selectedTemplate = selected as string;
      }

      // Offer to create the "Sandcastle" label on the repo
      const shouldCreateLabel = yield* Effect.promise(() =>
        clack.confirm({
          message:
            'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
          initialValue: true,
        }),
      );

      if (shouldCreateLabel === true) {
        yield* Effect.try({
          try: () =>
            execSync(
              'gh label create "Sandcastle" --description "Issues for Sandcastle to work on" --color "F9A825" 2>/dev/null',
              { cwd, stdio: "ignore" },
            ),
          catch: () => undefined,
        }).pipe(Effect.ignore);
      }

      yield* d.spinner(
        "Scaffolding .sandcastle/ config directory...",
        scaffold(cwd, provider, selectedTemplate).pipe(
          Effect.mapError(
            (e) =>
              new InitError({
                message: `${e instanceof Error ? e.message : e}`,
              }),
          ),
        ),
      );

      // Prompt user before building image
      const shouldBuild = yield* Effect.promise(() =>
        clack.confirm({
          message: "Build the default Docker image now?",
          initialValue: true,
        }),
      );

      if (shouldBuild === true) {
        const dockerfileDir = join(cwd, CONFIG_DIR);
        yield* d.spinner(
          `Building Docker image '${imageName}'...`,
          buildImage(imageName, dockerfileDir),
        );
        yield* d.status("Init complete! Image built successfully.", "success");
      } else {
        yield* d.status(
          "Init complete! Run `sandcastle build-image` to build the Docker image later.",
          "success",
        );
      }

      // Show template-specific next steps
      const nextSteps = getNextStepsLines(selectedTemplate, provider);
      for (const [i, line] of nextSteps.entries()) {
        yield* d.text(i === 0 ? line : styleText("dim", line));
      }
    }),
);

// --- Build-image command ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const dockerfileDir = join(cwd, CONFIG_DIR);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;
      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Interactive command ---

const modelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent (e.g. claude-sonnet-4-6)",
  ),
  Options.optional,
);

const interactiveSession = (options: {
  hostRepoDir: string;
  model?: string;
  agentName: string;
  interactiveArgs: string[];
}): Effect.Effect<
  void,
  import("./errors.js").SandboxError,
  SandboxFactory | Display
> =>
  Effect.gen(function* () {
    const { hostRepoDir, interactiveArgs } = options;
    const sandboxRepoDir = SANDBOX_WORKSPACE_DIR;
    const factory = yield* SandboxFactory;
    const d = yield* Display;

    yield* factory.withSandbox(({ hostWorktreePath }) =>
      withSandboxLifecycle(
        { hostRepoDir, sandboxRepoDir, hostWorktreePath },
        (ctx) =>
          Effect.gen(function* () {
            // Get container ID for docker exec -it
            const hostnameResult = yield* ctx.sandbox.exec("hostname");
            const containerId = hostnameResult.stdout.trim();

            // Launch interactive agent session with TTY passthrough
            yield* d.status(
              `Launching interactive ${options.agentName} session...`,
              "info",
            );

            const exitCode = yield* Effect.async<number, AgentError>(
              (resume) => {
                const proc = spawn(
                  "docker",
                  [
                    "exec",
                    "-it",
                    "-w",
                    ctx.sandboxRepoDir,
                    containerId,
                    ...interactiveArgs,
                  ],
                  { stdio: "inherit" },
                );

                proc.on("error", (error) => {
                  resume(
                    Effect.fail(
                      new AgentError({
                        message: `Failed to launch ${options.agentName}: ${error.message}`,
                      }),
                    ),
                  );
                });

                proc.on("close", (code) => {
                  resume(Effect.succeed(code ?? 0));
                });
              },
            );

            yield* d.status(
              `Session ended (exit code ${exitCode}). Syncing changes back...`,
              "info",
            );
          }),
      ),
    );
  });

const interactiveCommand = Command.make(
  "interactive",
  {
    imageName: imageNameOption,
    model: modelOption,
    agent: agentOption,
  },
  ({ imageName: imageNameFlag, model, agent }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      yield* requireConfigDir(hostRepoDir);

      const imageName = resolveImageName(imageNameFlag, hostRepoDir);

      // Resolve agent provider
      const provider = yield* Effect.try({
        try: () => getAgentProvider(agent),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      const resolvedModel =
        model._tag === "Some" ? model.value : provider.defaultModel;
      const interactiveArgs = provider.buildInteractiveArgs({
        model: resolvedModel,
      });

      // Resolve env vars
      const env = yield* resolveEnv(hostRepoDir);

      const d = yield* Display;
      yield* d.summary("Sandcastle Interactive", {
        Agent: provider.name,
        Image: imageName,
      });

      const factoryLayer = Layer.provide(
        WorktreeDockerSandboxFactory.layer,
        Layer.merge(
          Layer.succeed(WorktreeSandboxConfig, {
            imageName,
            env,
            hostRepoDir,
          }),
          NodeFileSystem.layer,
        ),
      );

      yield* interactiveSession({
        hostRepoDir,
        model: resolvedModel,
        agentName: provider.name,
        interactiveArgs,
      }).pipe(Effect.provide(factoryLayer));
    }),
);

// --- Root command ---

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status("Sandcastle v0.0.1", "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    buildImageCommand,
    removeImageCommand,
    interactiveCommand,
  ]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: "0.0.1",
});
