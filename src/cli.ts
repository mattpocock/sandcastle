import { Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import * as clack from "@clack/prompts";
import { execFile, execSync } from "node:child_process";
import { join } from "node:path";
import { styleText } from "node:util";

import { Display } from "./Display.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  buildImage as podmanBuildImage,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.js";
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  listIssueTrackers,
  getIssueTracker,
  listSandboxProviders,
  listSandboxProviderChoices,
  getSandboxProvider,
  getNextStepsLines,
  detectPackageManager,
  addDependencyCommand,
  hostHasDependency,
  getTemplateDependencies,
  buildImageShellCommand,
  parseBdVersion,
  beadsVersionWarning,
} from "./InitService.js";
import { defaultImageName } from "./sandboxes/docker.js";
import { ConfigDirError, InitError } from "./errors.js";
import type { DockerError, PodmanError } from "./errors.js";
import { VERSION } from "./version.js";

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const resolveImageName = (
  cliFlag: Option.Option<string>,
  cwd: string,
): string => (cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd));

// --- UID build-args ---

/** Build-args that align the image UID/GID to the host (Linux/macOS). No-op on Windows. */
const defaultUidBuildArgs = (): Record<string, string> => {
  const args: Record<string, string> = {};
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined) {
    args.AGENT_UID = String(uid);
  }
  if (gid !== undefined) {
    args.AGENT_GID = String(gid);
  }
  return args;
};

// --- Config directory check ---

const CONFIG_DIR = ".sandcastle";

const requireConfigDir = (
  cwd: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(join(cwd, CONFIG_DIR))),
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.filterOrFail(
      (exists) => exists,
      () =>
        new ConfigDirError({
          message: "No .sandcastle/ found. Run `sandcastle init` first.",
        }),
    ),
    Effect.asVoid,
  );

// --- Init flag resolution ---

const nonInteractiveMessage = (flags: readonly string[]): string =>
  `${flags.join(", ")} ${flags.length === 1 ? "is" : "are"} required in non-interactive mode (no TTY detected).`;

/** Succeeds when `ok`; otherwise fails with an InitError carrying `message`. */
const failInitUnless = (
  ok: boolean,
  message: string,
): Effect.Effect<void, InitError> =>
  ok ? Effect.void : Effect.fail(new InitError({ message }));

/**
 * The name the user chose: the CLI flag when given, else an interactive
 * select. Without a TTY a missing flag fails fast, naming the flag; cancelling
 * the prompt aborts init.
 */
const selectName = (params: {
  readonly flag: Option.Option<string>;
  readonly flagName: string;
  readonly isInteractive: boolean;
  readonly cancelMessage: string;
  readonly prompt: clack.SelectOptions<string>;
}): Effect.Effect<string, InitError> =>
  Effect.gen(function* () {
    if (params.flag._tag === "Some") {
      return params.flag.value;
    }
    if (!params.isInteractive) {
      return yield* new InitError({
        message: nonInteractiveMessage([params.flagName]),
      });
    }
    const selected = yield* Effect.promise(() => clack.select(params.prompt));
    if (clack.isCancel(selected)) {
      return yield* new InitError({ message: params.cancelMessage });
    }
    return selected;
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

const sandboxOption = Options.text("sandbox").pipe(
  Options.withDescription(
    "Sandbox provider to use (bwrap, seatbelt, docker or podman)",
  ),
  Options.optional,
);

const issueTrackerOption = Options.text("issue-tracker").pipe(
  Options.withDescription(
    "Issue tracker to use (e.g. github-issues, beads, custom)",
  ),
  Options.optional,
);

// Tri-state booleans (Some(true) / Some(false) / None) so we can tell "user
// chose false" from "user didn't pass the flag at all" — only the latter
// triggers the interactive prompt.
const createLabelOption = Options.choice("create-label", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    'Whether to create the "Sandcastle" GitHub label (only meaningful with --issue-tracker github-issues)',
  ),
  Options.optional,
);

const buildImageOption = Options.choice("build-image", ["true", "false"]).pipe(
  Options.withDescription(
    "Whether to build the sandbox image now (ignored when --issue-tracker custom is selected)",
  ),
  Options.optional,
);

const installTemplateDepsOption = Options.choice("install-template-deps", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    "Whether to install the template's host dependencies (e.g. zod for the planner templates)",
  ),
  Options.optional,
);

/**
 * Translate an `Options.choice("flag", ["true", "false"]).optional` value into
 * a tri-state boolean. None when the flag was absent; otherwise the parsed bool.
 */
const choiceToTriBool = (
  opt: Option.Option<"true" | "false">,
): Option.Option<boolean> =>
  opt._tag === "Some" ? Option.some(opt.value === "true") : Option.none();

/** The host's `bd version`, or undefined when bd isn't on the PATH. */
const detectHostBdVersion = (cwd: string): Effect.Effect<string | undefined> =>
  Effect.async((resume) => {
    execFile(
      "bd",
      ["version"],
      { cwd, encoding: "utf8", timeout: 15_000 },
      (_error, stdout, stderr) => {
        resume(Effect.succeed(parseBdVersion(`${stdout}\n${stderr}`)));
      },
    );
  });

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
    sandbox: sandboxOption,
    issueTracker: issueTrackerOption,
    createLabel: createLabelOption,
    buildImage: buildImageOption,
    installTemplateDeps: installTemplateDepsOption,
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    model: modelFlag,
    sandbox: sandboxFlag,
    issueTracker: issueTrackerFlag,
    createLabel: createLabelFlag,
    buildImage: buildImageFlag,
    installTemplateDeps: installTemplateDepsFlag,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag, cwd);
      // Only an explicit --image-name is written into the scaffold; without it
      // the sandbox factory's own default resolves to the same name as above.
      const customImageName = Option.getOrUndefined(imageNameFlag);

      // Early validation of CLI flags before interactive prompts
      const templates = listTemplates();
      if (template._tag === "Some") {
        const names = templates.map((tmpl) => tmpl.name).join(", ");
        yield* failInitUnless(
          templates.some((tmpl) => tmpl.name === template.value),
          `Unknown template "${template.value}". Available: ${names}`,
        );
      }

      if (sandboxFlag._tag === "Some") {
        const names = listSandboxProviders()
          .map((p) => p.name)
          .join(", ");
        yield* failInitUnless(
          getSandboxProvider(sandboxFlag.value) !== undefined,
          `Unknown sandbox provider "${sandboxFlag.value}". Available: ${names}`,
        );
      }

      if (issueTrackerFlag._tag === "Some") {
        const names = listIssueTrackers()
          .map((t) => t.name)
          .join(", ");
        yield* failInitUnless(
          getIssueTracker(issueTrackerFlag.value) !== undefined,
          `Unknown issue tracker "${issueTrackerFlag.value}". Available: ${names}`,
        );
      }

      if (agentFlag._tag === "Some") {
        const names = listAgents()
          .map((a) => a.name)
          .join(", ");
        yield* failInitUnless(
          getAgent(agentFlag.value) !== undefined,
          `Unknown agent "${agentFlag.value}". Available: ${names}`,
        );
      }

      const createLabelChoice = choiceToTriBool(createLabelFlag);
      const buildImageChoice = choiceToTriBool(buildImageFlag);
      const installTemplateDepsChoice = choiceToTriBool(
        installTemplateDepsFlag,
      );

      const isInteractive = process.stdin.isTTY === true;

      // Tri-state confirm: CLI flag wins; otherwise prompt interactively (or
      // fail fast in non-interactive mode naming the missing flag). Cancelling
      // the prompt is treated as abort — same shape as the select prompts below.
      const resolveConfirmFlag = (params: {
        choice: Option.Option<boolean>;
        flag: string;
        promptMessage: string;
        cancelMessage: string;
      }): Effect.Effect<boolean, InitError> =>
        Effect.gen(function* () {
          if (params.choice._tag === "Some") {
            return params.choice.value;
          }
          if (!isInteractive) {
            return yield* new InitError({
              message: nonInteractiveMessage([params.flag]),
            });
          }
          const confirmed = yield* Effect.promise(() =>
            clack.confirm({
              message: params.promptMessage,
              initialValue: true,
            }),
          );
          if (clack.isCancel(confirmed)) {
            return yield* new InitError({ message: params.cancelMessage });
          }
          return confirmed;
        });

      // Without a TTY, every prompt init would show must be answered by a flag.
      // Check them all here, before anything is written (the label, .sandcastle/,
      // zod), and name every missing flag at once, so a scripted init never
      // stops halfway with a partial scaffold behind it.
      if (!isInteractive) {
        const tracker = Option.getOrUndefined(issueTrackerFlag);
        const missing: string[] = [];
        if (agentFlag._tag === "None") {
          missing.push("--agent");
        }
        if (sandboxFlag._tag === "None") {
          missing.push("--sandbox");
        }
        if (tracker === undefined) {
          missing.push("--issue-tracker");
        }
        if (template._tag === "None") {
          missing.push("--template");
        }
        if (tracker === "github-issues" && createLabelChoice._tag === "None") {
          missing.push("--create-label");
        }
        if (
          template._tag === "Some" &&
          installTemplateDepsChoice._tag === "None" &&
          getTemplateDependencies(template.value).includes("zod") &&
          !(yield* hostHasDependency(cwd, "zod"))
        ) {
          missing.push("--install-template-deps");
        }
        // --build-image only applies to a provider with an image. Without
        // --sandbox the provider is unknown, so --build-image is still named.
        const sandboxName = Option.getOrUndefined(sandboxFlag);
        const providerHasImage =
          sandboxName === undefined ||
          getSandboxProvider(sandboxName)?.image !== undefined;
        if (
          tracker !== "custom" &&
          providerHasImage &&
          buildImageChoice._tag === "None"
        ) {
          missing.push("--build-image");
        }
        yield* failInitUnless(
          missing.length === 0,
          nonInteractiveMessage(missing),
        );
      }

      // Each choice below: CLI flag (already validated above) > interactive select.
      const selectedAgent = getAgent(
        yield* selectName({
          flag: agentFlag,
          flagName: "--agent",
          isInteractive,
          cancelMessage: "Agent selection cancelled.",
          prompt: {
            message: "Select an agent:",
            initialValue: "claude-code",
            options: listAgents().map((a) => ({
              value: a.name,
              label: a.label,
              hint: `Default model: ${a.defaultModel}`,
            })),
          },
        }),
      )!;

      // Resolve model: CLI flag > agent default
      const selectedModel =
        modelFlag._tag === "Some"
          ? modelFlag.value
          : selectedAgent.defaultModel;

      // No silent default sandbox provider: the user must choose. The host
      // OS's native provider is listed first and preselected.
      const sandboxChoices = listSandboxProviderChoices(process.platform);
      const recommendedSandbox = sandboxChoices.find((c) => c.recommended);
      const selectedSandboxProvider = getSandboxProvider(
        yield* selectName({
          flag: sandboxFlag,
          flagName: "--sandbox",
          isInteractive,
          cancelMessage: "Sandbox provider selection cancelled.",
          prompt: {
            message: "Select a sandbox provider:",
            ...(recommendedSandbox === undefined
              ? {}
              : { initialValue: recommendedSandbox.entry.name }),
            options: sandboxChoices.map(({ entry, recommended }) => ({
              value: entry.name,
              label: recommended ? `${entry.label} (recommended)` : entry.label,
            })),
          },
        }),
      )!;

      const selectedIssueTracker = getIssueTracker(
        yield* selectName({
          flag: issueTrackerFlag,
          flagName: "--issue-tracker",
          isInteractive,
          cancelMessage: "Issue tracker selection cancelled.",
          prompt: {
            message: "Select an issue tracker:",
            initialValue: "github-issues",
            options: listIssueTrackers().map((b) => ({
              value: b.name,
              label: b.label,
            })),
          },
        }),
      )!;

      const selectedTemplate = yield* selectName({
        flag: template,
        flagName: "--template",
        isInteractive,
        cancelMessage: "Template selection cancelled.",
        prompt: {
          message: "Select a template:",
          initialValue: "blank",
          options: templates.map((tmpl) => ({
            value: tmpl.name,
            label: tmpl.name,
            hint: tmpl.description,
          })),
        },
      });

      // Offer to create the "Sandcastle" label on the repo (skip for non-GitHub issue trackers).
      // CLI flag > interactive confirm. The flag is only meaningful for the github-issues tracker.
      let shouldCreateLabel = false;
      if (selectedIssueTracker.name === "github-issues") {
        shouldCreateLabel = yield* resolveConfirmFlag({
          choice: createLabelChoice,
          flag: "--create-label",
          promptMessage:
            'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
          cancelMessage: "Label selection cancelled.",
        });

        if (shouldCreateLabel) {
          yield* Effect.try({
            try: () =>
              execSync(
                'gh label create "Sandcastle" --description "Issues for Sandcastle to work on" --color "F9A825" 2>/dev/null',
                { cwd, stdio: "ignore" },
              ),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }
      }

      const scaffoldResult = yield* d.spinner(
        "Scaffolding .sandcastle/ config directory...",
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          createLabel: shouldCreateLabel,
          issueTracker: selectedIssueTracker,
          sandboxProvider: selectedSandboxProvider,
          imageName:
            selectedSandboxProvider.image === undefined
              ? undefined
              : customImageName,
        }).pipe(
          Effect.mapError(
            (e) =>
              new InitError({
                message: e instanceof Error ? e.message : e,
              }),
          ),
        ),
      );

      // Beads sandboxes open the host's .beads/ with the image's bd, so a
      // different host bd breaks one side or the other (see beadsVersionWarning).
      // Only an image-based provider has an image bd to disagree with.
      if (
        selectedIssueTracker.name === "beads" &&
        selectedSandboxProvider.image !== undefined
      ) {
        const warning = beadsVersionWarning(yield* detectHostBdVersion(cwd));
        if (warning !== undefined) {
          yield* d.status(warning, "warn");
        }
      }

      // Detect the host package manager so the zod offer below and the next
      // steps below both use the right install command.
      const packageManager = yield* detectPackageManager(cwd);

      // If the chosen template imports zod on the host (the planner templates
      // build their <plan> output schema with it) and the host doesn't already
      // declare it, offer to install it. Without this, the very first
      // `npx tsx .sandcastle/main.ts` crashes with ERR_MODULE_NOT_FOUND.
      const installedDependencies: string[] = [];
      if (getTemplateDependencies(selectedTemplate).includes("zod")) {
        const alreadyInstalled = yield* hostHasDependency(cwd, "zod");
        if (alreadyInstalled) {
          installedDependencies.push("zod");
        } else {
          const installCmd = addDependencyCommand(packageManager, "zod");
          const shouldInstall = yield* resolveConfirmFlag({
            choice: installTemplateDepsChoice,
            flag: "--install-template-deps",
            promptMessage: `The ${selectedTemplate} template needs a schema validator. Install zod now (\`${installCmd}\`)?`,
            cancelMessage: "Install-template-deps selection cancelled.",
          });
          if (shouldInstall) {
            const installed = yield* Effect.sync(() => {
              try {
                execSync(installCmd, { cwd, stdio: "ignore" });
                return true;
              } catch {
                return false;
              }
            });
            if (installed) {
              installedDependencies.push("zod");
            }
            yield* installed
              ? d.status(`Installed zod with ${packageManager}.`, "success")
              : d.status(
                  `Couldn't install zod automatically. Run \`${installCmd}\` before running the agent.`,
                  "warn",
                );
          }
        }
      }

      // Prompt user before building image. The custom issue tracker scaffolds
      // an intentionally unfinished Dockerfile (the install block is a TODO),
      // so there is nothing valid to build yet — skip the build prompt entirely
      // (and silently ignore --build-image) and let the next steps point the
      // user at the setup doc.
      // A provider with no image has nothing to build, so init skips the
      // build-image prompt (and ignores --build-image) for it.
      const providerLabel = selectedSandboxProvider.label;
      const providerImage = selectedSandboxProvider.image;
      if (providerImage === undefined) {
        yield* d.status(
          selectedIssueTracker.name === "custom"
            ? "Init complete! Your custom issue tracker isn't configured yet — see the steps below."
            : "Init complete!",
          "success",
        );
      } else if (selectedIssueTracker.name === "custom") {
        yield* d.status(
          "Init complete! Your custom issue tracker isn't configured yet — see the steps below before building.",
          "success",
        );
      } else {
        const shouldBuild = yield* resolveConfirmFlag({
          choice: buildImageChoice,
          flag: "--build-image",
          promptMessage: `Build the default ${providerLabel} image now?`,
          cancelMessage: "Build-image selection cancelled.",
        });

        if (shouldBuild) {
          const containerfileDir = join(cwd, CONFIG_DIR);
          const build: Effect.Effect<void, DockerError | PodmanError> =
            selectedSandboxProvider.name === "podman"
              ? podmanBuildImage(imageName, containerfileDir)
              : buildImage(imageName, containerfileDir, {
                  buildArgs: defaultUidBuildArgs(),
                });
          yield* d.spinner(
            `Building ${providerLabel} image '${imageName}'...`,
            build,
          );
          yield* d.status(
            "Init complete! Image built successfully.",
            "success",
          );
        } else {
          yield* d.status(
            `Init complete! Run \`${buildImageShellCommand(providerImage, customImageName)}\` to build the ${providerLabel} image later.`,
            "success",
          );
        }
      }

      // Show template-specific next steps
      const nextSteps = getNextStepsLines(
        selectedTemplate,
        scaffoldResult.mainFilename,
        selectedIssueTracker,
        selectedAgent,
        packageManager,
        installedDependencies,
        selectedSandboxProvider,
      );
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
          buildArgs: defaultUidBuildArgs(),
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

// --- Docker namespace command ---

const dockerCommand = Command.make("docker", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]));

// --- Podman build-image command ---

const containerfileOption = Options.file("containerfile").pipe(
  Options.withDescription(
    "Path to a custom Containerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const podmanBuildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    containerfile: containerfileOption,
  },
  ({ imageName: imageNameFlag, containerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const containerfileDir = join(cwd, CONFIG_DIR);
      const containerfilePath =
        containerfile._tag === "Some" ? containerfile.value : undefined;
      yield* d.spinner(
        `Building Podman image '${imageName}'...`,
        podmanBuildImage(imageName, containerfileDir, {
          containerfile: containerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Podman remove-image command ---

const podmanRemoveImageCommand = Command.make(
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
        `Removing Podman image '${imageName}'...`,
        podmanRemoveImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Podman namespace command ---

const podmanCommand = Command.make("podman", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Podman sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand]),
);

// --- Root command ---

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`Sandcastle v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([initCommand, dockerCommand, podmanCommand]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: VERSION,
});
