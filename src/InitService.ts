import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_WORKSPACE_DIR } from "./SandboxFactory.js";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

export interface DetectedPackageManager {
  readonly name: PackageManagerName;
  readonly version?: string;
}

const GITIGNORE = `.env
logs/
worktrees/
`;

export interface TemplateMetadata {
  name: string;
  description: string;
}

const TEMPLATES: TemplateMetadata[] = [
  {
    name: "blank",
    description: "Bare scaffold — write your own prompt and orchestration",
  },
  {
    name: "simple-loop",
    description: "Picks GitHub issues one by one and closes them",
  },
  {
    name: "sequential-reviewer",
    description:
      "Implements issues one by one, with a code review step after each",
  },
  {
    name: "parallel-planner",
    description:
      "Plans parallelizable issues, executes on separate branches, merges",
  },
];

export const listTemplates = (): TemplateMetadata[] => TEMPLATES;

// ---------------------------------------------------------------------------
// Agent registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface AgentEntry {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly factoryImport: string;
  readonly dockerfileTemplate: string;
}

const CLAUDE_CODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user for Claude to run as
RUN useradd -m -s /bin/bash agent
USER agent

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_WORKSPACE_DIR}
# and overrides the working directory to ${SANDBOX_WORKSPACE_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_WORKSPACE_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const PI_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN useradd -m -s /bin/bash agent

# Install pi coding agent (run as root before USER agent)
RUN npm install -g @mariozechner/pi-coding-agent

USER agent

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_WORKSPACE_DIR}
# and overrides the working directory to ${SANDBOX_WORKSPACE_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_WORKSPACE_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const CODEX_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN useradd -m -s /bin/bash agent

# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex

USER agent

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_WORKSPACE_DIR}
# and overrides the working directory to ${SANDBOX_WORKSPACE_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_WORKSPACE_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const AGENT_REGISTRY: AgentEntry[] = [
  {
    name: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-6",
    factoryImport: "claudeCode",
    dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
  },
  {
    name: "pi",
    label: "Pi",
    defaultModel: "claude-sonnet-4-6",
    factoryImport: "pi",
    dockerfileTemplate: PI_DOCKERFILE,
  },
  {
    name: "codex",
    label: "Codex",
    defaultModel: "gpt-5.4-mini",
    factoryImport: "codex",
    dockerfileTemplate: CODEX_DOCKERFILE,
  },
];

export const listAgents = (): AgentEntry[] => AGENT_REGISTRY;

export const getAgent = (name: string): AgentEntry | undefined =>
  AGENT_REGISTRY.find((a) => a.name === name);

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

export function getNextStepsLines(
  template: string,
  packageManager: PackageManagerName = "npm",
): string[] {
  const pm = packageManager;
  if (template === "blank") {
    return [
      "Next steps:",
      `1. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
      "2. Read and customize .sandcastle/prompt.md to describe what you want the agent to do",
      `3. Customize .sandcastle/main.ts — it uses the JS API (\`run()\`) to control how the agent runs`,
      `4. Add "sandcastle": "npx tsx .sandcastle/main.ts" to your package.json scripts`,
      `5. Run \`${pm} run sandcastle\` to start the agent`,
    ];
  } else {
    return [
      "Next steps:",
      `1. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
      `2. Add "sandcastle": "npx tsx .sandcastle/main.ts" to your package.json scripts`,
      `3. Templates use \`copyToSandbox: ["node_modules"]\` to copy your host node_modules into the sandbox for fast startup — the \`${pm} install\` in the onSandboxReady hook is a safety net for platform-specific binaries`,
      "4. Read and customize the prompt files in .sandcastle/ — they shape what the agent does",
      `5. Run \`${pm} run sandcastle\` to start the agent`,
    ];
  }
}

// ---------------------------------------------------------------------------
// Package manager Dockerfile helpers
// ---------------------------------------------------------------------------

/**
 * Build a Dockerfile RUN instruction to install the given package manager.
 * Returns undefined for npm (already available in the Node base image).
 */
function buildPackageManagerInstallLine(
  pm: DetectedPackageManager,
): string | undefined {
  switch (pm.name) {
    case "npm":
      return undefined;
    case "pnpm":
    case "yarn": {
      // Strip +sha512.xxx integrity hash from version — corepack doesn't need it
      const version = pm.version?.replace(/\+.*$/, "");
      const spec = version ? `${pm.name}@${version}` : `${pm.name}@latest`;
      return `RUN corepack enable && corepack prepare ${spec} --activate`;
    }
    case "bun":
      return "RUN npm install -g bun";
  }
}

/**
 * Insert a package-manager install line into a Dockerfile string,
 * before the USER line so it runs as root.
 */
function insertPackageManagerInDockerfile(
  dockerfile: string,
  installLine: string,
): string {
  return dockerfile.replace(
    /^(USER .*)$/m,
    `# Install project package manager\n${installLine}\n\n$1`,
  );
}

/**
 * Replace npm command references in file content with the target package manager.
 * Handles: "npm install", "npm run <script>", and comment references.
 */
function substitutePackageManager(
  content: string,
  pm: PackageManagerName,
): string {
  if (pm === "npm") return content;
  return content
    .replace(/\bnpm install\b/g, `${pm} install`)
    .replace(/\bnpm run\b/g, `${pm} run`);
}

// ---------------------------------------------------------------------------
// Scaffolding helpers
// ---------------------------------------------------------------------------

function getTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "templates");
}

const getTemplateDir = (
  templateName: string,
): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const template = TEMPLATES.find((t) => t.name === templateName);
    if (!template) {
      const names = TEMPLATES.map((t) => t.name).join(", ");
      yield* Effect.fail(
        new Error(`Unknown template: "${templateName}". Available: ${names}`),
      );
    }
    return join(getTemplatesDir(), templateName);
  });

const COMPILED_FILE_EXTENSIONS = [".js", ".js.map", ".d.ts", ".d.ts.map"];

const copyTemplateFiles = (
  templateDir: string,
  destDir: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(templateDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* Effect.all(
      files
        .filter(
          (f) =>
            f !== "template.json" &&
            !COMPILED_FILE_EXTENSIONS.some((ext) => f.endsWith(ext)),
        )
        .map((f) =>
          fs
            .copyFile(join(templateDir, f), join(destDir, f))
            .pipe(Effect.mapError((e) => new Error(e.message))),
        ),
      { concurrency: "unbounded" },
    );
  });

/**
 * Replace the agent factory import and call in a scaffolded main.ts.
 *
 * Templates use `claudeCode` as the default factory. When a different agent or
 * model is selected, this function rewrites the import and factory calls.
 */
const rewriteMainTs = (
  configDir: string,
  agent: AgentEntry,
  model: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mainTsPath = join(configDir, "main.ts");

    const exists = yield* fs
      .exists(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (!exists) return;

    let content = yield* fs
      .readFileString(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));

    // Replace factory function name in imports (e.g. claudeCode → pi)
    // and all factory calls with the correct model.
    // Templates always use claudeCode as the placeholder factory.
    content = content.replace(/\bclaudeCode\b/g, agent.factoryImport);
    // Replace model strings in factory calls: factoryImport("any-model")
    const factoryCallRe = new RegExp(
      `${agent.factoryImport}\\(["']([^"']+)["']\\)`,
      "g",
    );
    content = content.replace(
      factoryCallRe,
      `${agent.factoryImport}("${model}")`,
    );

    yield* fs
      .writeFileString(mainTsPath, content)
      .pipe(Effect.mapError((e) => new Error(e.message)));
  });

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
  agent: AgentEntry;
  model: string;
  templateName?: string;
  packageManager?: DetectedPackageManager;
}

export const scaffold = (
  repoDir: string,
  options: ScaffoldOptions,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const {
      agent,
      model,
      templateName = "blank",
      packageManager = { name: "npm" as const },
    } = options;
    const fs = yield* FileSystem.FileSystem;
    const configDir = join(repoDir, ".sandcastle");

    const exists = yield* fs
      .exists(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (exists) {
      yield* Effect.fail(
        new Error(
          ".sandcastle/ directory already exists. Remove it first if you want to re-initialize.",
        ),
      );
    }

    yield* fs
      .makeDirectory(configDir, { recursive: false })
      .pipe(Effect.mapError((e) => new Error(e.message)));

    const templateDir = yield* getTemplateDir(templateName);

    // Build Dockerfile with optional package manager install line
    let dockerfile = agent.dockerfileTemplate;
    const installLine = buildPackageManagerInstallLine(packageManager);
    if (installLine) {
      dockerfile = insertPackageManagerInDockerfile(dockerfile, installLine);
    }

    yield* Effect.all(
      [
        fs
          .writeFileString(join(configDir, "Dockerfile"), dockerfile)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".gitignore"), GITIGNORE)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        copyTemplateFiles(templateDir, configDir),
      ],
      { concurrency: "unbounded" },
    );

    // Rewrite main.ts with the selected agent factory and model
    yield* rewriteMainTs(configDir, agent, model);

    // Substitute package manager in all generated files
    if (packageManager.name !== "npm") {
      yield* rewritePackageManagerRefs(configDir, packageManager.name);
    }
  });

/**
 * Rewrite npm references in all .ts and .md files in the config directory.
 */
const rewritePackageManagerRefs = (
  configDir: string,
  pm: PackageManagerName,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));

    const rewritable = files.filter(
      (f) => f.endsWith(".ts") || f.endsWith(".md"),
    );

    yield* Effect.all(
      rewritable.map((f) =>
        Effect.gen(function* () {
          const path = join(configDir, f);
          let content = yield* fs
            .readFileString(path)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const updated = substitutePackageManager(content, pm);
          if (updated !== content) {
            yield* fs
              .writeFileString(path, updated)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });
