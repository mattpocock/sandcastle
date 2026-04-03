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
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  getNextStepsLines,
} from "./InitService.js";
import { defaultImageName } from "./run.js";
import type { PackageManagerName } from "./InitService.js";
import {
  claudeCode,
  codex as codexFactory,
  pi as piFactory,
  DEFAULT_MODEL,
  type AgentProvider,
} from "./AgentProvider.js";
import type { AgentEntry } from "./InitService.js";
import { AgentError, ConfigDirError, InitError } from "./errors.js";
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

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Agent to use (e.g. claude-code)"),
  Options.optional,
);

const initModelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent (e.g. claude-sonnet-4-6). Defaults to the agent's default model",
  ),
  Options.optional,
);

const packageManagerOption = Options.text("package-manager").pipe(
  Options.withDescription(
    "Package manager to use in generated files (npm, pnpm, yarn, bun). Prompted interactively if omitted",
  ),
  Options.optional,
);

const VALID_PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
    packageManager: packageManagerOption,
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    model: modelFlag,
    packageManager: packageManagerFlag,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag, cwd);

      // Resolve agent: CLI flag > interactive select
      const agents = listAgents();
      let selectedAgent: AgentEntry;
      if (agentFlag._tag === "Some") {
        const entry = getAgent(agentFlag.value);
        if (!entry) {
          const names = agents.map((a) => a.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown agent "${agentFlag.value}". Available: ${names}`,
            }),
          );
        }
        selectedAgent = entry!;
      } else {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an agent:",
            initialValue: "claude-code",
            options: agents.map((a) => ({
              value: a.name,
              label: a.label,
              hint: `Default model: ${a.defaultModel}`,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Agent selection cancelled." }),
          );
        }
        selectedAgent = getAgent(selected as string)!;
      }

      // Resolve model: CLI flag > agent default
      const selectedModel =
        modelFlag._tag === "Some"
          ? modelFlag.value
          : selectedAgent.defaultModel;

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

      // Resolve package manager: CLI flag > interactive select
      let selectedPm: PackageManagerName;
      if (packageManagerFlag._tag === "Some") {
        const name = packageManagerFlag.value;
        if (
          !VALID_PACKAGE_MANAGERS.includes(
            name as (typeof VALID_PACKAGE_MANAGERS)[number],
          )
        ) {
          yield* Effect.fail(
            new InitError({
              message: `Unknown package manager "${name}". Available: ${VALID_PACKAGE_MANAGERS.join(", ")}`,
            }),
          );
        }
        selectedPm = name as PackageManagerName;
      } else {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a package manager:",
            initialValue: "npm" as const,
            options: VALID_PACKAGE_MANAGERS.map((pm) => ({
              value: pm,
              label: pm,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Package manager selection cancelled." }),
          );
        }
        selectedPm = selected as PackageManagerName;
      }

      yield* d.spinner(
        "Scaffolding .sandcastle/ config directory...",
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          packageManager: { name: selectedPm },
        }).pipe(
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
      const nextSteps = getNextStepsLines(selectedTemplate, selectedPm);
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

/** CLI-internal registry mapping agent names to factory + default model */
const AGENT_REGISTRY: Record<
  string,
  { factory: (model: string) => AgentProvider; defaultModel: string }
> = {
  "claude-code": { factory: claudeCode, defaultModel: DEFAULT_MODEL },
  pi: { factory: piFactory, defaultModel: "claude-sonnet-4-6" },
  codex: { factory: codexFactory, defaultModel: "gpt-5.4-mini" },
};

const interactiveAgentOption = Options.text("agent").pipe(
  Options.withDescription(
    `Agent provider to use (${Object.keys(AGENT_REGISTRY).join(", ")})`,
  ),
  Options.withDefault("claude-code"),
);

const modelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent (e.g. claude-sonnet-4-6)",
  ),
  Options.optional,
);

const interactiveSession = (options: {
  hostRepoDir: string;
  provider: AgentProvider;
}): Effect.Effect<
  void,
  import("./errors.js").SandboxError,
  SandboxFactory | Display
> =>
  Effect.gen(function* () {
    const { hostRepoDir, provider } = options;
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

            yield* d.status(
              `Launching interactive ${provider.name} session...`,
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
                    ...provider.buildInteractiveArgs(""),
                  ],
                  { stdio: "inherit" },
                );

                proc.on("error", (error) => {
                  resume(
                    Effect.fail(
                      new AgentError({
                        message: `Failed to launch ${provider.name}: ${error.message}`,
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
    agent: interactiveAgentOption,
    model: modelOption,
  },
  ({ imageName: imageNameFlag, agent: agentName, model }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      yield* requireConfigDir(hostRepoDir);

      const imageName = resolveImageName(imageNameFlag, hostRepoDir);

      // Resolve agent provider from registry
      const entry = AGENT_REGISTRY[agentName];
      if (!entry) {
        const available = Object.keys(AGENT_REGISTRY).join(", ");
        yield* Effect.fail(
          new AgentError({
            message: `Unknown agent "${agentName}". Available: ${available}`,
          }),
        );
        return; // unreachable, satisfies TypeScript
      }
      const resolvedModel =
        model._tag === "Some" ? model.value : entry.defaultModel;
      const provider = entry.factory(resolvedModel);

      // Resolve env vars
      const env = yield* resolveEnv(hostRepoDir);

      const d = yield* Display;
      yield* d.summary("Sandcastle Interactive", {
        Image: imageName,
        Agent: provider.name,
        Model: resolvedModel,
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
        provider,
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
