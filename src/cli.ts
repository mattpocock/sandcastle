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
  sandboxProviderPreflightWarning,
  agentCliWarning,
} from "./InitService.js";
import type {
  AgentEntry,
  IssueTrackerEntry,
  PackageManager,
  SandboxProviderEntry,
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
 * The registry entry `selectName` resolved. The flags and prompts only offer
 * registry names, so a miss is a bug; fail with an InitError naming it.
 */
const registryEntry = <T>(
  entry: T | undefined,
  what: string,
): Effect.Effect<T, InitError> =>
  entry === undefined
    ? Effect.fail(new InitError({ message: `Unknown ${what}` }))
    : Effect.succeed(entry);

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

/** The `init` flags, as parsed. */
interface InitFlags {
  readonly imageName: Option.Option<string>;
  readonly template: Option.Option<string>;
  readonly agent: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly sandbox: Option.Option<string>;
  readonly issueTracker: Option.Option<string>;
  readonly createLabel: Option.Option<"true" | "false">;
  readonly buildImage: Option.Option<"true" | "false">;
  readonly installTemplateDeps: Option.Option<"true" | "false">;
}

/** The tri-state confirm flags: Some when the flag was passed. */
interface InitConfirmChoices {
  readonly createLabel: Option.Option<boolean>;
  readonly buildImage: Option.Option<boolean>;
  readonly installTemplateDeps: Option.Option<boolean>;
}

/** Fails when a registry flag names something that doesn't exist. */
const validateRegistryFlags = (
  flags: InitFlags,
): Effect.Effect<void, InitError> =>
  Effect.gen(function* () {
    const { template } = flags;
    if (template._tag === "Some") {
      const templates = listTemplates();
      const names = templates.map((tmpl) => tmpl.name).join(", ");
      yield* failInitUnless(
        templates.some((tmpl) => tmpl.name === template.value),
        `Unknown template "${template.value}". Available: ${names}`,
      );
    }

    if (flags.sandbox._tag === "Some") {
      const names = listSandboxProviders()
        .map((p) => p.name)
        .join(", ");
      yield* failInitUnless(
        getSandboxProvider(flags.sandbox.value) !== undefined,
        `Unknown sandbox provider "${flags.sandbox.value}". Available: ${names}`,
      );
    }

    if (flags.issueTracker._tag === "Some") {
      const names = listIssueTrackers()
        .map((t) => t.name)
        .join(", ");
      yield* failInitUnless(
        getIssueTracker(flags.issueTracker.value) !== undefined,
        `Unknown issue tracker "${flags.issueTracker.value}". Available: ${names}`,
      );
    }

    if (flags.agent._tag === "Some") {
      const names = listAgents()
        .map((a) => a.name)
        .join(", ");
      yield* failInitUnless(
        getAgent(flags.agent.value) !== undefined,
        `Unknown agent "${flags.agent.value}". Available: ${names}`,
      );
    }
  });

/**
 * Tri-state confirm: CLI flag wins; otherwise prompt interactively (or
 * fail fast in non-interactive mode naming the missing flag). Cancelling
 * the prompt is treated as abort — same shape as the select prompts.
 */
const resolveConfirmFlag = (params: {
  choice: Option.Option<boolean>;
  flag: string;
  isInteractive: boolean;
  promptMessage: string;
  cancelMessage: string;
}): Effect.Effect<boolean, InitError> =>
  Effect.gen(function* () {
    if (params.choice._tag === "Some") {
      return params.choice.value;
    }
    if (!params.isInteractive) {
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

/**
 * Whether the template needs a host dependency (zod) the host lacks, so
 * init would ask about --install-template-deps.
 */
const asksToInstallTemplateDeps = (
  template: Option.Option<string>,
  choice: Option.Option<boolean>,
  cwd: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  template._tag === "Some" &&
  choice._tag === "None" &&
  getTemplateDependencies(template.value).includes("zod")
    ? Effect.map(hostHasDependency(cwd, "zod"), (has) => !has)
    : Effect.succeed(false);

/** The flags a non-interactive init is missing for the prompts it would show. */
const missingInitFlags = (
  flags: InitFlags,
  choices: InitConfirmChoices,
  cwd: string,
): Effect.Effect<string[], never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const tracker = Option.getOrUndefined(flags.issueTracker);
    const { template } = flags;
    const missing: string[] = [];
    if (flags.agent._tag === "None") {
      missing.push("--agent");
    }
    if (flags.sandbox._tag === "None") {
      missing.push("--sandbox");
    }
    if (tracker === undefined) {
      missing.push("--issue-tracker");
    }
    if (template._tag === "None") {
      missing.push("--template");
    }
    if (tracker === "github-issues" && choices.createLabel._tag === "None") {
      missing.push("--create-label");
    }
    if (
      yield* asksToInstallTemplateDeps(
        template,
        choices.installTemplateDeps,
        cwd,
      )
    ) {
      missing.push("--install-template-deps");
    }
    // --build-image only applies to a provider with an image. Without
    // --sandbox the provider is unknown, so --build-image is still named.
    const sandboxName = Option.getOrUndefined(flags.sandbox);
    const providerHasImage =
      sandboxName === undefined ||
      getSandboxProvider(sandboxName)?.image !== undefined;
    if (
      tracker !== "custom" &&
      providerHasImage &&
      choices.buildImage._tag === "None"
    ) {
      missing.push("--build-image");
    }
    return missing;
  });

/** What the user chose, by flag or prompt. */
interface InitSelection {
  readonly agent: AgentEntry;
  readonly model: string;
  readonly sandboxProvider: SandboxProviderEntry;
  readonly issueTracker: IssueTrackerEntry;
  readonly template: string;
}

const selectAgent = (
  flag: Option.Option<string>,
  isInteractive: boolean,
): Effect.Effect<AgentEntry, InitError> =>
  selectName({
    flag,
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
  }).pipe(
    Effect.flatMap((name) => registryEntry(getAgent(name), `agent "${name}"`)),
  );

/**
 * No silent default sandbox provider: the user must choose. The host
 * OS's native provider is listed first and preselected.
 */
const selectSandboxProvider = (
  flag: Option.Option<string>,
  isInteractive: boolean,
): Effect.Effect<SandboxProviderEntry, InitError> => {
  const sandboxChoices = listSandboxProviderChoices(process.platform);
  const recommendedSandbox = sandboxChoices.find((c) => c.recommended);
  return selectName({
    flag,
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
  }).pipe(
    Effect.flatMap((name) =>
      registryEntry(getSandboxProvider(name), `sandbox provider "${name}"`),
    ),
  );
};

const selectIssueTracker = (
  flag: Option.Option<string>,
  isInteractive: boolean,
): Effect.Effect<IssueTrackerEntry, InitError> =>
  selectName({
    flag,
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
  }).pipe(
    Effect.flatMap((name) =>
      registryEntry(getIssueTracker(name), `issue tracker "${name}"`),
    ),
  );

const selectTemplate = (
  flag: Option.Option<string>,
  isInteractive: boolean,
): Effect.Effect<string, InitError> =>
  selectName({
    flag,
    flagName: "--template",
    isInteractive,
    cancelMessage: "Template selection cancelled.",
    prompt: {
      message: "Select a template:",
      initialValue: "blank",
      options: listTemplates().map((tmpl) => ({
        value: tmpl.name,
        label: tmpl.name,
        hint: tmpl.description,
      })),
    },
  });

/** Each choice: CLI flag (already validated) > interactive select. */
const selectInitChoices = (
  flags: InitFlags,
  isInteractive: boolean,
): Effect.Effect<InitSelection, InitError> =>
  Effect.gen(function* () {
    const agent = yield* selectAgent(flags.agent, isInteractive);
    // Resolve model: CLI flag > agent default
    const model =
      flags.model._tag === "Some" ? flags.model.value : agent.defaultModel;
    const sandboxProvider = yield* selectSandboxProvider(
      flags.sandbox,
      isInteractive,
    );
    const issueTracker = yield* selectIssueTracker(
      flags.issueTracker,
      isInteractive,
    );
    const template = yield* selectTemplate(flags.template, isInteractive);
    return { agent, model, sandboxProvider, issueTracker, template };
  });

/**
 * Offer to create the "Sandcastle" label on the repo (skip for non-GitHub
 * issue trackers). CLI flag > interactive confirm. The flag is only
 * meaningful for the github-issues tracker. Returns whether it was chosen.
 */
const offerSandcastleLabel = (
  selection: InitSelection,
  choice: Option.Option<boolean>,
  context: { readonly cwd: string; readonly isInteractive: boolean },
): Effect.Effect<boolean, InitError> =>
  Effect.gen(function* () {
    if (selection.issueTracker.name !== "github-issues") {
      return false;
    }
    const shouldCreateLabel = yield* resolveConfirmFlag({
      choice,
      flag: "--create-label",
      isInteractive: context.isInteractive,
      promptMessage:
        'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
      cancelMessage: "Label selection cancelled.",
    });

    if (shouldCreateLabel) {
      yield* Effect.try({
        try: () =>
          execSync(
            'gh label create "Sandcastle" --description "Issues for Sandcastle to work on" --color "F9A825"',
            { cwd: context.cwd, stdio: "ignore" },
          ),
        catch: () => undefined,
      }).pipe(Effect.ignore);
    }
    return shouldCreateLabel;
  });

/**
 * Warns about host tools the chosen setup needs but doesn't find: the native
 * sandbox tool and agent CLI, and a beads `bd` that disagrees with the image.
 */
const warnHostPrerequisites = (
  selection: InitSelection,
  cwd: string,
): Effect.Effect<void, never, Display | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const d = yield* Display;
    const { sandboxProvider } = selection;
    // A native provider runs on the host's own sandbox tool. Check it works
    // now, so a missing tool shows up at init, not on the first run.
    const preflightWarning = sandboxProviderPreflightWarning(sandboxProvider);
    if (preflightWarning !== undefined) {
      yield* d.status(preflightWarning, "warn");
    }
    // ...and the agent CLI it runs is installed on the host.
    if (sandboxProvider.image === undefined) {
      const agentWarning = yield* agentCliWarning(
        selection.agent,
        sandboxProvider,
      );
      if (agentWarning !== undefined) {
        yield* d.status(agentWarning, "warn");
      }
    }

    // Beads sandboxes open the host's .beads/ with the image's bd, so a
    // different host bd breaks one side or the other (see beadsVersionWarning).
    // Only an image-based provider has an image bd to disagree with.
    if (
      selection.issueTracker.name === "beads" &&
      sandboxProvider.image !== undefined
    ) {
      const warning = beadsVersionWarning(yield* detectHostBdVersion(cwd));
      if (warning !== undefined) {
        yield* d.status(warning, "warn");
      }
    }
  });

/** Runs `installCmd`; whether it succeeded. */
const tryInstall = (installCmd: string, cwd: string): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      execSync(installCmd, { cwd, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });

/**
 * If the chosen template imports zod on the host (the planner templates
 * build their <plan> output schema with it) and the host doesn't already
 * declare it, offer to install it. Without this, the very first
 * `npx tsx .sandcastle/main.ts` crashes with ERR_MODULE_NOT_FOUND.
 * Returns the template dependencies the host now has.
 */
const offerTemplateDeps = (
  template: string,
  choice: Option.Option<boolean>,
  context: {
    readonly cwd: string;
    readonly isInteractive: boolean;
    readonly packageManager: PackageManager;
  },
): Effect.Effect<string[], InitError, Display | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { cwd, packageManager } = context;
    if (!getTemplateDependencies(template).includes("zod")) {
      return [];
    }
    if (yield* hostHasDependency(cwd, "zod")) {
      return ["zod"];
    }
    const installCmd = addDependencyCommand(packageManager, "zod");
    const shouldInstall = yield* resolveConfirmFlag({
      choice,
      flag: "--install-template-deps",
      isInteractive: context.isInteractive,
      promptMessage: `The ${template} template needs a schema validator. Install zod now (\`${installCmd}\`)?`,
      cancelMessage: "Install-template-deps selection cancelled.",
    });
    if (!shouldInstall) {
      return [];
    }
    const d = yield* Display;
    const installed = yield* tryInstall(installCmd, cwd);
    yield* installed
      ? d.status(`Installed zod with ${packageManager}.`, "success")
      : d.status(
          `Couldn't install zod automatically. Run \`${installCmd}\` before running the agent.`,
          "warn",
        );
    return installed ? ["zod"] : [];
  });

/** Builds the scaffolded image with the provider's engine. */
const buildDefaultImage = (
  sandboxProvider: SandboxProviderEntry,
  imageName: string,
  cwd: string,
): Effect.Effect<void, DockerError | PodmanError> => {
  const containerfileDir = join(cwd, CONFIG_DIR);
  return sandboxProvider.name === "podman"
    ? podmanBuildImage(imageName, containerfileDir)
    : buildImage(imageName, containerfileDir, {
        buildArgs: defaultUidBuildArgs(),
      });
};

/**
 * Prompt user before building image. The custom issue tracker scaffolds
 * an intentionally unfinished Dockerfile (the install block is a TODO),
 * so there is nothing valid to build yet — skip the build prompt entirely
 * (and silently ignore --build-image) and let the next steps point the
 * user at the setup doc.
 * A provider with no image has nothing to build, so init skips the
 * build-image prompt (and ignores --build-image) for it.
 */
const finishInit = (
  selection: InitSelection,
  choice: Option.Option<boolean>,
  context: {
    readonly cwd: string;
    readonly isInteractive: boolean;
    readonly imageName: string;
    readonly customImageName: string | undefined;
  },
): Effect.Effect<void, InitError | DockerError | PodmanError, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    const { sandboxProvider, issueTracker } = selection;
    const { imageName } = context;
    const providerLabel = sandboxProvider.label;
    const providerImage = sandboxProvider.image;
    if (providerImage === undefined) {
      return yield* d.status(
        issueTracker.name === "custom"
          ? "Init complete! Your custom issue tracker isn't configured yet — see the steps below."
          : "Init complete!",
        "success",
      );
    }
    if (issueTracker.name === "custom") {
      return yield* d.status(
        "Init complete! Your custom issue tracker isn't configured yet — see the steps below before building.",
        "success",
      );
    }
    const shouldBuild = yield* resolveConfirmFlag({
      choice,
      flag: "--build-image",
      isInteractive: context.isInteractive,
      promptMessage: `Build the default ${providerLabel} image now?`,
      cancelMessage: "Build-image selection cancelled.",
    });

    if (!shouldBuild) {
      return yield* d.status(
        `Init complete! Run \`${buildImageShellCommand(providerImage, context.customImageName)}\` to build the ${providerLabel} image later.`,
        "success",
      );
    }
    yield* d.spinner(
      `Building ${providerLabel} image '${imageName}'...`,
      buildDefaultImage(sandboxProvider, imageName, context.cwd),
    );
    yield* d.status("Init complete! Image built successfully.", "success");
  });

/**
 * Validates the flags and settles every choice, by flag or prompt, before
 * anything is written.
 */
const decideInit = (
  flags: InitFlags,
): Effect.Effect<
  {
    cwd: string;
    isInteractive: boolean;
    choices: InitConfirmChoices;
    selection: InitSelection;
  },
  InitError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const cwd = process.cwd();
    // Early validation of CLI flags before interactive prompts
    yield* validateRegistryFlags(flags);

    const choices: InitConfirmChoices = {
      createLabel: choiceToTriBool(flags.createLabel),
      buildImage: choiceToTriBool(flags.buildImage),
      installTemplateDeps: choiceToTriBool(flags.installTemplateDeps),
    };

    const isInteractive = process.stdin.isTTY === true;

    // Without a TTY, every prompt init would show must be answered by a flag.
    // Check them all here, before anything is written (the label, .sandcastle/,
    // zod), and name every missing flag at once, so a scripted init never
    // stops halfway with a partial scaffold behind it.
    if (!isInteractive) {
      const missing = yield* missingInitFlags(flags, choices, cwd);
      yield* failInitUnless(
        missing.length === 0,
        nonInteractiveMessage(missing),
      );
    }

    const selection = yield* selectInitChoices(flags, isInteractive);
    return { cwd, isInteractive, choices, selection };
  });

/** Scaffolds `.sandcastle/` for what the user chose. */
const scaffoldSelection = (
  selection: InitSelection,
  options: {
    readonly cwd: string;
    readonly createLabel: boolean;
    readonly customImageName: string | undefined;
  },
): Effect.Effect<{ mainFilename: string }, InitError, FileSystem.FileSystem> =>
  scaffold(options.cwd, {
    agent: selection.agent,
    model: selection.model,
    templateName: selection.template,
    createLabel: options.createLabel,
    issueTracker: selection.issueTracker,
    sandboxProvider: selection.sandboxProvider,
    imageName:
      selection.sandboxProvider.image === undefined
        ? undefined
        : options.customImageName,
  }).pipe(
    Effect.mapError(
      (e) =>
        new InitError({
          message: e instanceof Error ? e.message : e,
        }),
    ),
  );

/** Prints the first line plain and the rest dimmed. */
const printLines = (
  lines: readonly string[],
): Effect.Effect<void, never, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    for (const [i, line] of lines.entries()) {
      yield* d.text(i === 0 ? line : styleText("dim", line));
    }
  });

/**
 * After scaffolding: offer the template's host dependencies and the image
 * build, then print the next steps.
 */
const completeInit = (
  selection: InitSelection,
  choices: InitConfirmChoices,
  context: {
    readonly cwd: string;
    readonly isInteractive: boolean;
    readonly flags: InitFlags;
    readonly mainFilename: string;
  },
): Effect.Effect<
  void,
  InitError | DockerError | PodmanError,
  Display | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const { cwd, flags } = context;
    // Detect the host package manager so the zod offer below and the next
    // steps below both use the right install command.
    const packageManager = yield* detectPackageManager(cwd);
    const installedDependencies = yield* offerTemplateDeps(
      selection.template,
      choices.installTemplateDeps,
      { ...context, packageManager },
    );

    yield* finishInit(selection, choices.buildImage, {
      ...context,
      imageName: resolveImageName(flags.imageName, cwd),
      customImageName: Option.getOrUndefined(flags.imageName),
    });

    // Show template-specific next steps
    yield* printLines(
      getNextStepsLines(
        selection.template,
        context.mainFilename,
        selection.issueTracker,
        selection.agent,
        packageManager,
        installedDependencies,
        selection.sandboxProvider,
      ),
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
  (flags) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const { cwd, isInteractive, choices, selection } =
        yield* decideInit(flags);
      const context = { cwd, isInteractive };
      const shouldCreateLabel = yield* offerSandcastleLabel(
        selection,
        choices.createLabel,
        context,
      );

      const scaffoldResult = yield* d.spinner(
        "Scaffolding .sandcastle/ config directory...",
        scaffoldSelection(selection, {
          cwd,
          createLabel: shouldCreateLabel,
          // Only an explicit --image-name is written into the scaffold;
          // without it the sandbox factory's own default resolves to the
          // same name as resolveImageName.
          customImageName: Option.getOrUndefined(flags.imageName),
        }),
      );

      yield* warnHostPrerequisites(selection, cwd);

      yield* completeInit(selection, choices, {
        ...context,
        flags,
        mainFilename: scaffoldResult.mainFilename,
      });
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
