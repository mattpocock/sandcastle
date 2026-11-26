import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import { join } from "node:path";
import { InitError } from "./errors.js";
import type { AgentEntry } from "./initAgents.js";
import type { PackageManager } from "./initPackageManager.js";
import {
  addDependencyCommand,
  readHostPackageJson,
} from "./initPackageManager.js";
import type { SandboxProviderEntry } from "./initSandboxProviders.js";

const GITIGNORE = `.env
`;

export interface TemplateMetadata {
  readonly name: string;
  readonly description: string;
}

const TEMPLATES: readonly TemplateMetadata[] = [
  {
    name: "blank",
    description:
      "One sandbox and one agent session — write your own prompt and workflow",
  },
];

/** The 0.x templates, built on `run()`, which 1.0.0 removed. */
const REMOVED_TEMPLATES: ReadonlySet<string> = new Set([
  "simple-loop",
  "sequential-reviewer",
  "parallel-planner",
  "parallel-planner-with-review",
]);

export const listTemplates = (): readonly TemplateMetadata[] => TEMPLATES;

/**
 * Why `init --template <name>` can't scaffold `name`, or undefined when it
 * can. A removed 0.x template says so, rather than reading as a typo.
 */
export const templateError = (name: string): string | undefined => {
  if (TEMPLATES.some((t) => t.name === name)) {
    return undefined;
  }
  const available = TEMPLATES.map((t) => t.name).join(", ");
  return REMOVED_TEMPLATES.has(name)
    ? `The "${name}" template was removed in 1.0.0, with run(). Available: ${available}. It scaffolds one sandbox and one agent session, which you build your own workflow on.`
    : `Unknown template "${name}". Available: ${available}`;
};

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

export interface NextStepsOptions {
  readonly mainFilename: string;
  readonly agent: AgentEntry;
  readonly sandboxProvider: SandboxProviderEntry;
  readonly packageManager: PackageManager;
  /** Whether the host already has the provider's vendor SDK. */
  readonly hasPeerDependency: boolean;
}

export const getNextStepsLines = (options: NextStepsOptions): string[] => {
  const { mainFilename, agent, sandboxProvider, packageManager } = options;
  const { peerDependency } = sandboxProvider;
  const steps = [
    "Copy .sandcastle/.env.example to .sandcastle/.env and fill it in",
    ...(peerDependency === undefined || options.hasPeerDependency
      ? []
      : [
          `Install the ${sandboxProvider.label} SDK: \`${addDependencyCommand(packageManager, peerDependency)}\``,
        ]),
    sandboxProvider.setupNote,
    "Describe what you want the agent to do in .sandcastle/prompt.md",
    `Customize .sandcastle/${mainFilename}: it creates the sandbox, runs one session and prints the agent's final message. Clone your repo into the sandbox there first`,
    `Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts, then run \`${packageManager} run sandcastle\``,
  ];
  const lines = ["Next steps:"];
  for (const [i, step] of steps.entries()) {
    lines.push(`${i + 1}. ${step}`);
    if (i === 0 && agent.name === "claude-code") {
      lines.push(
        "   To use your Claude subscription instead of an API key, run `claude setup-token` on your host and paste the result into CLAUDE_CODE_OAUTH_TOKEN.",
      );
    }
  }
  return lines;
};

// ---------------------------------------------------------------------------
// The main file
// ---------------------------------------------------------------------------

/** What gets written into the scaffolded main file. */
export interface MainFileChoices {
  readonly mainFilename: string;
  readonly agent: AgentEntry;
  readonly model: string;
  readonly sandboxProvider: SandboxProviderEntry;
}

// The template is written for claudeCode on bwrap(); these are the lines
// init rewrites for the chosen agent and provider.
const TEMPLATE_PROVIDER_IMPORT =
  'import { bwrap } from "@ai-hero/sandcastle/v1/sandboxes/bwrap";';
const TEMPLATE_PROVIDER_CALL = "provider: bwrap(),";
const TEMPLATE_ENV_BINDING = "const env = Object.fromEntries(";
const TEMPLATE_AGENT_CALL = 'claudeCode("claude-opus-4-8")';

const BACKSLASH = "\u005C";

/** `value` as a double-quoted TypeScript string literal. */
const stringLiteral = (value: string): string =>
  `"${value.replaceAll(BACKSLASH, BACKSLASH.repeat(2)).replaceAll('"', `${BACKSLASH}"`)}"`;

/** `content` with `anchor` replaced once; fails when the template lacks it. */
const replaceAnchor = (
  content: string,
  anchor: string,
  replacement: string,
): Effect.Effect<string, InitError> =>
  content.includes(anchor)
    ? Effect.succeed(content.replace(anchor, () => replacement))
    : Effect.fail(
        new InitError({
          message: `The blank template's main file has no \`${anchor}\` to rewrite.`,
        }),
      );

/** The template's main file, rewritten for the chosen agent, model and provider. */
export const renderMainFile = (
  template: string,
  choices: MainFileChoices,
): Effect.Effect<string, InitError> =>
  Effect.gen(function* () {
    const { agent, sandboxProvider: provider } = choices;
    const { credentials } = provider;
    let content =
      choices.mainFilename === "main.ts"
        ? template.replaceAll("main.mts", "main.ts")
        : template;
    content = yield* replaceAnchor(
      content,
      TEMPLATE_AGENT_CALL,
      `claudeCode(${stringLiteral(choices.model)})`,
    );
    content = content.replaceAll(/\bclaudeCode\b/gu, agent.factoryImport);
    content = yield* replaceAnchor(
      content,
      TEMPLATE_PROVIDER_IMPORT,
      `import { ${provider.name} } from "@ai-hero/sandcastle/v1/sandboxes/${provider.name}";`,
    );
    content = yield* replaceAnchor(
      content,
      TEMPLATE_PROVIDER_CALL,
      `provider: ${provider.call},`,
    );
    if (credentials.length > 0) {
      const one = credentials.length === 1;
      const names = `${credentials.slice(0, -1).join(", ")}${one ? "" : " and "}${credentials.at(-1) ?? ""}`;
      content = yield* replaceAnchor(
        content,
        TEMPLATE_ENV_BINDING,
        [
          `// ${names} ${one ? "stays" : "stay"} on this machine:`,
          `// ${provider.name}() gets ${one ? "it" : "them"}, the sandbox doesn't.`,
          "const {",
          ...credentials.map((name) => `  ${name},`),
          "  ...env",
          "} = Object.fromEntries(",
        ].join("\n"),
      );
    }
    return content;
  });

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
  readonly agent: AgentEntry;
  readonly model: string;
  readonly sandboxProvider: SandboxProviderEntry;
}

export interface ScaffoldResult {
  readonly mainFilename: string;
}

const getTemplateDir = (): string =>
  join(import.meta.dirname, "templates", "blank");

/**
 * Detect whether the project's package.json has `"type": "module"`.
 * If so, we can use plain `.ts`; otherwise we use `.mts` to ensure ESM.
 */
const detectMainFilename = (
  repoDir: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const pkg = yield* readHostPackageJson(repoDir);
    return Option.getOrUndefined(pkg)?.["type"] === "module"
      ? "main.ts"
      : "main.mts";
  });

const toInitError = (e: { readonly message: string }): InitError =>
  new InitError({ message: e.message });

/** Creates `.sandcastle/`, failing when it already exists. */
const createConfigDir = (
  configDir: string,
): Effect.Effect<void, InitError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(configDir)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
    if (exists) {
      return yield* new InitError({
        message:
          ".sandcastle/ directory already exists. Remove it first if you want to re-initialize.",
      });
    }
    yield* fs
      .makeDirectory(configDir, { recursive: false })
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
  });

/** `.env.example`: the agent's keys, then the provider's credentials. */
const envExample = (choices: ScaffoldOptions): string =>
  `${[choices.agent.envExample, choices.sandboxProvider.envExample]
    .filter((part) => part !== "")
    .join("\n")}\n`;

/**
 * Scaffolds `.sandcastle/` in `repoDir` with the blank template: a main file
 * for the chosen agent, model and provider, its prompt, `.env.example` and
 * `.gitignore`. Fails, writing nothing, when `.sandcastle/` already exists.
 */
export const scaffold = (
  repoDir: string,
  options: ScaffoldOptions,
): Effect.Effect<ScaffoldResult, InitError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configDir = join(repoDir, ".sandcastle");
    const templateDir = getTemplateDir();
    // Reads package.json only, so it can run before the directory exists.
    const mainFilename = yield* detectMainFilename(repoDir);

    const main = yield* fs
      .readFileString(join(templateDir, "main.mts"))
      .pipe(Effect.mapError(toInitError));
    const rendered = yield* renderMainFile(main, { ...options, mainFilename });

    yield* createConfigDir(configDir);
    yield* Effect.all(
      [
        fs.writeFileString(join(configDir, mainFilename), rendered),
        fs.copyFile(
          join(templateDir, "prompt.md"),
          join(configDir, "prompt.md"),
        ),
        fs.writeFileString(
          join(configDir, ".env.example"),
          envExample(options),
        ),
        fs.writeFileString(join(configDir, ".gitignore"), GITIGNORE),
      ].map((write) => write.pipe(Effect.mapError(toInitError))),
      { concurrency: "unbounded" },
    );
    return { mainFilename };
  });
