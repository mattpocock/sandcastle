import { Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import type { Option } from "effect";
import * as clack from "@clack/prompts";
import { join, resolve } from "node:path";
import { styleText } from "node:util";

import { Display } from "./Display.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  buildImage as podmanBuildImage,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.js";
import { scaffold, templateError, getNextStepsLines } from "./InitService.js";
import {
  detectPackageManager,
  hostHasDependency,
} from "./initPackageManager.js";
import { agentCliWarning, getAgent, listAgents } from "./initAgents.js";
import type { AgentEntry } from "./initAgents.js";
import {
  getSandboxProvider,
  listSandboxProviderChoices,
  listSandboxProviders,
  sandboxProviderPreflightWarning,
} from "./initSandboxProviders.js";
import type { SandboxProviderEntry } from "./initSandboxProviders.js";
import { defaultImageName } from "./sandboxes/docker.js";
import { ConfigDirError, InitError } from "./errors.js";
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

const NATIVE_SANDBOX_HINT =
  "Native sandboxes (bwrap(), seatbelt(), noSandbox()) run without an image, so you only need one for a container sandbox.";

/**
 * Fails with a clear message when none of `candidates` exists, so a missing
 * build file is not reported as the container runtime being down.
 */
const requireBuildFile = (
  candidates: readonly string[],
  message: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      Effect.all(candidates.map((candidate) => fs.exists(candidate))),
    ),
    Effect.catchAll(() => Effect.succeed([false])),
    Effect.filterOrFail(
      (found) => found.some(Boolean),
      () => new ConfigDirError({ message }),
    ),
    Effect.asVoid,
  );

/**
 * Why `docker build-image` found no `.sandcastle/Dockerfile`. A project
 * scaffolded for podman has a Containerfile instead, so point at the podman
 * command rather than at native sandboxes.
 */
const missingDockerfileMessage = (
  dockerfileDir: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(join(dockerfileDir, "Containerfile"))),
    Effect.orElseSucceed(() => false),
    Effect.map((hasContainerfile) =>
      hasContainerfile
        ? `No Dockerfile found at ${CONFIG_DIR}/Dockerfile, but found ${CONFIG_DIR}/Containerfile: this project was scaffolded for podman. Run \`sandcastle podman build-image\`, or pass --dockerfile ${CONFIG_DIR}/Containerfile.`
        : `No Dockerfile found at ${CONFIG_DIR}/Dockerfile. ${NATIVE_SANDBOX_HINT} To build one, add ${CONFIG_DIR}/Dockerfile or pass --dockerfile <path>.`,
    ),
  );

// --- Init command ---

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

const templateOption = Options.text("template").pipe(
  Options.withDescription(
    "Template to scaffold. The only one is blank, which init uses when this is left out",
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
    `Sandbox provider to use (${listSandboxProviders()
      .map((p) => p.name)
      .join(", ")})`,
  ),
  Options.optional,
);

/** The `init` flags, as parsed. */
interface InitFlags {
  readonly template: Option.Option<string>;
  readonly agent: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly sandbox: Option.Option<string>;
}

/** Fails when a flag names something that doesn't exist. */
const validateRegistryFlags = (
  flags: InitFlags,
): Effect.Effect<void, InitError> =>
  Effect.gen(function* () {
    if (flags.template._tag === "Some") {
      const error = templateError(flags.template.value);
      yield* failInitUnless(error === undefined, error ?? "");
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

/** What the user chose, by flag or prompt. */
interface InitSelection {
  readonly agent: AgentEntry;
  readonly model: string;
  readonly sandboxProvider: SandboxProviderEntry;
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

/**
 * Validates the flags and settles every choice, by flag or prompt, before
 * anything is written. There is one template, so init never asks for one.
 */
const decideInit = (
  flags: InitFlags,
): Effect.Effect<InitSelection, InitError> =>
  Effect.gen(function* () {
    yield* validateRegistryFlags(flags);
    const isInteractive = process.stdin.isTTY === true;

    // Without a TTY, every prompt init would show must be answered by a flag.
    // Name every missing flag at once, before anything is written.
    if (!isInteractive) {
      const missing = [
        ...(flags.agent._tag === "None" ? ["--agent"] : []),
        ...(flags.sandbox._tag === "None" ? ["--sandbox"] : []),
      ];
      yield* failInitUnless(
        missing.length === 0,
        nonInteractiveMessage(missing),
      );
    }

    const agent = yield* selectAgent(flags.agent, isInteractive);
    const model =
      flags.model._tag === "Some" ? flags.model.value : agent.defaultModel;
    const sandboxProvider = yield* selectSandboxProvider(
      flags.sandbox,
      isInteractive,
    );
    return { agent, model, sandboxProvider };
  });

/**
 * Warns about host tools the chosen provider needs but doesn't find: the
 * native sandbox tool, and the agent CLI a provider running the host's own
 * programs needs.
 */
const warnHostPrerequisites = (
  selection: InitSelection,
): Effect.Effect<void, never, Display | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const d = yield* Display;
    const { sandboxProvider } = selection;
    const preflightWarning = sandboxProviderPreflightWarning(sandboxProvider);
    if (preflightWarning !== undefined) {
      yield* d.status(preflightWarning, "warn");
    }
    if (sandboxProvider.runsHostPrograms) {
      const agentWarning = yield* agentCliWarning(
        selection.agent,
        sandboxProvider,
      );
      if (agentWarning !== undefined) {
        yield* d.status(agentWarning, "warn");
      }
    }
  });

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

const initCommand = Command.make(
  "init",
  {
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
    sandbox: sandboxOption,
  },
  (flags) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const selection = yield* decideInit(flags);

      const { mainFilename } = yield* d.spinner(
        "Scaffolding .sandcastle/ config directory...",
        scaffold(cwd, selection),
      );

      yield* warnHostPrerequisites(selection);
      yield* d.status("Init complete!", "success");

      const { peerDependency } = selection.sandboxProvider;
      yield* printLines(
        getNextStepsLines({
          mainFilename,
          agent: selection.agent,
          sandboxProvider: selection.sandboxProvider,
          packageManager: yield* detectPackageManager(cwd),
          hasPeerDependency:
            peerDependency !== undefined &&
            (yield* hostHasDependency(cwd, peerDependency)),
        }),
      );
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
      yield* dockerfilePath === undefined
        ? requireBuildFile(
            [join(dockerfileDir, "Dockerfile")],
            yield* missingDockerfileMessage(dockerfileDir),
          )
        : requireBuildFile(
            [resolve(dockerfilePath)],
            `Dockerfile not found: ${dockerfilePath}`,
          );

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
      yield* containerfilePath === undefined
        ? requireBuildFile(
            [
              join(containerfileDir, "Containerfile"),
              join(containerfileDir, "Dockerfile"),
            ],
            `No Containerfile or Dockerfile found in ${CONFIG_DIR}/. ${NATIVE_SANDBOX_HINT} To build one, add ${CONFIG_DIR}/Containerfile or pass --containerfile <path>.`,
          )
        : requireBuildFile(
            [resolve(containerfilePath)],
            `Containerfile not found: ${containerfilePath}`,
          );
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
