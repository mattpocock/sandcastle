import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";

const GITIGNORE = `.env
logs/
worktrees/
`;

/**
 * Filename of the setup prompt scaffolded for the `custom` issue tracker.
 * Both the per-agent `setupCommand` and the in-scaffold sentinels point at it,
 * so it is defined once here.
 */
const SETUP_ISSUE_TRACKER_DOC = "SETUP_ISSUE_TRACKER.md";
const SETUP_ISSUE_TRACKER_PATH = `.sandcastle/${SETUP_ISSUE_TRACKER_DOC}`;

export interface TemplateMetadata {
  name: string;
  description: string;
  /**
   * Host-side npm packages the template's `main` file imports directly (e.g.
   * the planner templates import `zod` for their `<plan>` output schema). Init
   * offers to install these with the detected package manager so that
   * `npx tsx .sandcastle/main.ts` doesn't crash with ERR_MODULE_NOT_FOUND.
   */
  dependencies?: readonly string[];
}

const TEMPLATES: TemplateMetadata[] = [
  {
    name: "blank",
    description: "Bare scaffold — write your own prompt and orchestration",
  },
  {
    name: "simple-loop",
    description: "Picks issues one by one and closes them",
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
    dependencies: ["zod"],
  },
  {
    name: "parallel-planner-with-review",
    description:
      "Plans parallelizable issues, executes with per-branch review, merges",
    dependencies: ["zod"],
  },
];

export const listTemplates = (): TemplateMetadata[] => TEMPLATES;

/**
 * Host-side npm packages the given template imports directly. Empty when the
 * template name is unknown or the template declares no extra dependencies.
 */
export const getTemplateDependencies = (
  templateName: string,
): readonly string[] =>
  TEMPLATES.find((t) => t.name === templateName)?.dependencies ?? [];

// ---------------------------------------------------------------------------
// Package manager detection (internal — not part of public API)
// ---------------------------------------------------------------------------

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

/** A package manager Sandcastle can detect on the host and build install commands for. */
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

// Lockfiles checked in priority order. bun.lock / bun.lockb are both valid bun
// lockfiles (text vs binary), so both map to bun.
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/**
 * Detect the host project's package manager. An explicit corepack-style
 * `packageManager` field in package.json wins; otherwise the first matching
 * lockfile decides. Defaults to npm when nothing matches.
 */
export const detectPackageManager = (
  repoDir: string,
): Effect.Effect<PackageManager, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const pkgPath = join(repoDir, "package.json");
    const pkgExists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (pkgExists) {
      const content = yield* fs
        .readFileString(pkgPath)
        .pipe(Effect.orElseSucceed(() => ""));
      try {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        const field = pkg["packageManager"];
        if (typeof field === "string") {
          const name = field.split("@")[0];
          const match = PACKAGE_MANAGERS.find((pm) => pm === name);
          if (match) return match;
        }
      } catch {
        // Malformed package.json — fall through to lockfile detection.
      }
    }

    for (const [file, pm] of LOCKFILES) {
      const exists = yield* fs
        .exists(join(repoDir, file))
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) return pm;
    }

    return "npm";
  });

/** Build the command that adds a runtime dependency for the given package manager. */
export const addDependencyCommand = (
  packageManager: PackageManager,
  pkg: string,
): string => {
  switch (packageManager) {
    case "pnpm":
      return `pnpm add ${pkg}`;
    case "yarn":
      return `yarn add ${pkg}`;
    case "bun":
      return `bun add ${pkg}`;
    case "npm":
      return `npm install ${pkg}`;
  }
};

/**
 * Whether the host package.json already declares `pkg` in any of its dependency
 * maps. Used so init doesn't offer to install something already present.
 */
export const hostHasDependency = (
  repoDir: string,
  pkg: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(repoDir, "package.json");
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return false;
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const depMaps = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ];
      return depMaps.some((key) => {
        const deps = parsed[key];
        return (
          typeof deps === "object" && deps !== null && pkg in (deps as object)
        );
      });
    } catch {
      return false;
    }
  });

// ---------------------------------------------------------------------------
// Agent registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface AgentEntry {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly factoryImport: string;
  readonly dockerfileTemplate: string;
  /** Lines to include in the generated `.env.example` for this agent's API key. */
  readonly envExample: string;
  /**
   * Copy-pasteable interactive command that feeds the custom-issue-tracker
   * setup prompt to this agent's CLI on the host. Printed in init's next steps
   * when the `custom` issue tracker is selected. Runs on the host (the
   * sandbox image isn't built yet), so the user must have the CLI installed.
   */
  readonly setupCommand: string;
}

const CLAUDE_CODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const PI_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install pi coding agent (run as root before USER agent)
RUN npm install -g @mariozechner/pi-coding-agent

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const CODEX_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const CURSOR_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -g $AGENT_GID node && usermod -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Cursor Agent CLI
RUN curl https://cursor.com/install -fsS | bash

# Add Cursor CLI to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const OPENCODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install OpenCode CLI (run as root before USER agent)
RUN npm install -g opencode-ai@latest

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const COPILOT_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install GitHub Copilot CLI (run as root before USER agent)
RUN npm install -g @github/copilot

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const AGENT_REGISTRY: AgentEntry[] = [
  {
    name: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-7",
    factoryImport: "claudeCode",
    dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
    envExample: `# Anthropic API key
# If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191
ANTHROPIC_API_KEY=`,
    setupCommand: `claude "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "pi",
    label: "Pi",
    defaultModel: "claude-sonnet-4-6",
    factoryImport: "pi",
    dockerfileTemplate: PI_DOCKERFILE,
    envExample: `# Anthropic API key
ANTHROPIC_API_KEY=`,
    setupCommand: `pi "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "codex",
    label: "Codex",
    defaultModel: "gpt-5.4",
    factoryImport: "codex",
    dockerfileTemplate: CODEX_DOCKERFILE,
    envExample: `# OpenAI API key
OPENAI_KEY=`,
    setupCommand: `codex "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "cursor",
    label: "Cursor",
    defaultModel: "composer-2",
    factoryImport: "cursor",
    dockerfileTemplate: CURSOR_DOCKERFILE,
    envExample: `# Cursor API key (recommended)
# You can also pass --api-key directly to the agent CLI.
CURSOR_API_KEY=`,
    setupCommand: `agent "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "opencode",
    label: "OpenCode",
    defaultModel: "opencode/big-pickle",
    factoryImport: "opencode",
    dockerfileTemplate: OPENCODE_DOCKERFILE,
    envExample: `# OpenCode API key
OPENCODE_API_KEY=`,
    setupCommand: `opencode --prompt "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "copilot",
    label: "GitHub Copilot CLI",
    defaultModel: "claude-sonnet-4.5",
    factoryImport: "copilot",
    dockerfileTemplate: COPILOT_DOCKERFILE,
    envExample: `# GitHub token with the "Copilot Requests" permission
# (a fine-grained PAT, or any token from \`gh auth login\`).
# COPILOT_GITHUB_TOKEN takes precedence over GH_TOKEN and GITHUB_TOKEN.
GITHUB_TOKEN=`,
    setupCommand: `copilot -i "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
];

export const listAgents = (): AgentEntry[] => AGENT_REGISTRY;

// ---------------------------------------------------------------------------
// Issue tracker registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface IssueTrackerEntry {
  readonly name: string;
  readonly label: string;
  readonly templateArgs: {
    readonly LIST_TASKS_COMMAND: string;
    readonly VIEW_TASK_COMMAND: string;
    readonly CLOSE_TASK_COMMAND: string;
    readonly ISSUE_TRACKER_TOOLS: string;
  };
  /** Lines to append to `.env.example` for this issue tracker, or empty string if none needed. */
  readonly envExample: string;
}

const GITHUB_CLI_TOOLS = `# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*`;

const BEADS_TOOLS = `# Install system dependencies for Beads
RUN apt-get update && apt-get install -y \\
  dpkg-dev \\
  libicu72 \\
  && rm -rf /var/lib/apt/lists/* \\
  && ARCH_DIR=$(dpkg-architecture -qDEB_HOST_MULTIARCH) \\
  && for lib in /usr/lib/$ARCH_DIR/libicu*.so.72; do \\
       ln -s "$lib" "\${lib%.72}.74"; \\
     done

RUN curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

RUN corepack enable`;

// Sentinels baked into the scaffold for the `custom` issue tracker. The
// project ships deliberately broken-until-configured; the setup agent finds
// and replaces these markers in place (see SETUP_ISSUE_TRACKER.md). Defined as
// shared constants so the registry entry and the setup doc stay in sync.
const CUSTOM_LIST_TASKS_SENTINEL = `echo 'No issue tracker configured — run ${SETUP_ISSUE_TRACKER_PATH} through your coding agent.' >&2; exit 1`;
const CUSTOM_VIEW_TASK_MARKER = `<view command — see ${SETUP_ISSUE_TRACKER_PATH}>`;
const CUSTOM_CLOSE_TASK_MARKER = `<close command — see ${SETUP_ISSUE_TRACKER_PATH}>`;
const CUSTOM_TRACKER_TOOLS = `# TODO: install your issue tracker's CLI here. See ${SETUP_ISSUE_TRACKER_PATH}`;
const CUSTOM_ENV_EXAMPLE = `# TODO: add any env vars your issue tracker needs (e.g. an API token).
# See ${SETUP_ISSUE_TRACKER_PATH}`;

const ISSUE_TRACKER_REGISTRY: IssueTrackerEntry[] = [
  {
    name: "github-issues",
    label: "GitHub Issues",
    templateArgs: {
      LIST_TASKS_COMMAND: `gh issue list --state open --label Sandcastle --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`,
      VIEW_TASK_COMMAND: "gh issue view <ID>",
      CLOSE_TASK_COMMAND: `gh issue close <ID> --comment "Completed by Sandcastle"`,
      ISSUE_TRACKER_TOOLS: GITHUB_CLI_TOOLS,
    },
    envExample: `# GitHub personal access token — the agent uses it to read and manage GitHub Issues
# Create a fine-grained token: https://github.com/settings/personal-access-tokens/new
# Required repository permissions: Issues (Read and write) and Metadata (Read)
GH_TOKEN=`,
  },
  {
    name: "beads",
    label: "Beads",
    templateArgs: {
      LIST_TASKS_COMMAND: "bd ready --json",
      VIEW_TASK_COMMAND: "bd show <ID>",
      CLOSE_TASK_COMMAND: `bd close <ID> --reason="Completed by Sandcastle"`,
      ISSUE_TRACKER_TOOLS: BEADS_TOOLS,
    },
    envExample: "",
  },
  {
    name: "custom",
    label: "Custom",
    templateArgs: {
      // The only real shell expression: PromptPreprocessor fails the run on a
      // non-zero exit and surfaces stderr, so this is the single enforcement
      // point that keeps the scaffold broken until the user configures it.
      LIST_TASKS_COMMAND: CUSTOM_LIST_TASKS_SENTINEL,
      // Inline text markers — replaced by the setup agent, never executed.
      VIEW_TASK_COMMAND: CUSTOM_VIEW_TASK_MARKER,
      CLOSE_TASK_COMMAND: CUSTOM_CLOSE_TASK_MARKER,
      ISSUE_TRACKER_TOOLS: CUSTOM_TRACKER_TOOLS,
    },
    envExample: CUSTOM_ENV_EXAMPLE,
  },
];

export const listIssueTrackers = (): IssueTrackerEntry[] =>
  ISSUE_TRACKER_REGISTRY;

export const getIssueTracker = (name: string): IssueTrackerEntry | undefined =>
  ISSUE_TRACKER_REGISTRY.find((b) => b.name === name);

export const getAgent = (name: string): AgentEntry | undefined =>
  AGENT_REGISTRY.find((a) => a.name === name);

// ---------------------------------------------------------------------------
// Sandbox provider registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface SandboxProviderEntry {
  readonly name: string;
  readonly label: string;
  /** Filename written to .sandcastle/ (e.g. "Dockerfile" or "Containerfile") */
  readonly containerfileName: string;
  /** CLI namespace for build/remove commands (e.g. "docker" or "podman") */
  readonly cliNamespace: string;
}

const SANDBOX_PROVIDER_REGISTRY: SandboxProviderEntry[] = [
  {
    name: "docker",
    label: "Docker",
    containerfileName: "Dockerfile",
    cliNamespace: "docker",
  },
  {
    name: "podman",
    label: "Podman",
    containerfileName: "Containerfile",
    cliNamespace: "podman",
  },
];

export const listSandboxProviders = (): SandboxProviderEntry[] =>
  SANDBOX_PROVIDER_REGISTRY;

export const getSandboxProvider = (
  name: string,
): SandboxProviderEntry | undefined =>
  SANDBOX_PROVIDER_REGISTRY.find((p) => p.name === name);

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

export function getNextStepsLines(
  template: string,
  mainFilename: string,
  issueTracker: IssueTrackerEntry,
  agent: AgentEntry,
  packageManager: PackageManager,
): string[] {
  // The custom issue tracker scaffolds a broken-until-configured project, so
  // its next steps are about running the setup prompt — not the template's
  // normal "set env vars and go" flow. This branch wins over template-specific
  // steps regardless of the chosen template.
  if (issueTracker.name === "custom") {
    return [
      "Next steps:",
      "1. Your custom issue tracker isn't wired up yet — runs hard-fail until you configure it.",
      `2. Feed the setup prompt to ${agent.label} on your host to finish wiring it up:`,
      `   ${agent.setupCommand}`,
      `   (Runs on the host — you need the ${agent.label} CLI installed locally, since the sandbox image isn't built yet.)`,
      `3. Follow .sandcastle/${SETUP_ISSUE_TRACKER_DOC} to edit the scaffolded files in place, build the image, and verify.`,
    ];
  }
  if (template === "blank") {
    return [
      "Next steps:",
      `1. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
      "   If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191",
      "2. Read and customize .sandcastle/prompt.md to describe what you want the agent to do",
      `3. Customize .sandcastle/${mainFilename} — it uses the JS API (\`run()\`) to control how the agent runs`,
      `4. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      "5. Run `npm run sandcastle` to start the agent",
    ];
  } else {
    const hasReviewer = template.includes("review");
    const usesPlanSchema = getTemplateDependencies(template).includes("zod");
    let step = 1;
    const lines: string[] = [
      "Next steps:",
      `${step++}. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
      "   If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191",
      `${step++}. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      `${step++}. Templates use \`copyToWorktree: ["node_modules"]\` to copy your host node_modules into the sandbox for fast startup — the \`npm install\` in the onSandboxReady hook is a safety net for platform-specific binaries. Adjust both if you use a different package manager`,
    ];
    if (usesPlanSchema) {
      lines.push(
        `${step++}. Install a schema validator for the planner's \`<plan>\` output — the template uses Zod (\`${addDependencyCommand(packageManager, "zod")}\`), but Valibot, ArkType, or any Standard Schema library works (https://standardschema.dev)`,
      );
    }
    lines.push(
      `${step++}. Read and customize the prompt files in .sandcastle/ — they shape what the agent does`,
    );
    if (hasReviewer) {
      lines.push(
        `${step++}. Customize .sandcastle/CODING_STANDARDS.md with your project's standards — the reviewer agent loads it during review`,
      );
    }
    lines.push(`${step++}. Run \`npm run sandcastle\` to start the agent`);
    return lines;
  }
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

const COMPILED_FILE_EXTENSIONS = [
  ".js",
  ".js.map",
  ".d.ts",
  ".d.ts.map",
  ".mjs",
  ".mjs.map",
  ".d.mts",
  ".d.mts.map",
];

const copyTemplateFiles = (
  templateDir: string,
  destDir: string,
  mainFilename: string,
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
            f !== ".env.example" &&
            !COMPILED_FILE_EXTENSIONS.some((ext) => f.endsWith(ext)),
        )
        .map((f) => {
          const destName = f === "main.mts" ? mainFilename : f;
          return fs
            .copyFile(join(templateDir, f), join(destDir, destName))
            .pipe(Effect.mapError((e) => new Error(e.message)));
        }),
      { concurrency: "unbounded" },
    );
  });

/**
 * Replace the agent factory and sandbox provider in a scaffolded main.ts.
 *
 * Templates use `claudeCode` as the default agent factory and `docker` as the
 * default sandbox provider. When a different agent, model, or sandbox provider
 * is selected, this function rewrites the imports and factory calls.
 */
const rewriteMainTs = (
  configDir: string,
  agent: AgentEntry,
  model: string,
  sandboxProvider: SandboxProviderEntry,
  mainFilename: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mainTsPath = join(configDir, mainFilename);

    const exists = yield* fs
      .exists(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (!exists) return;

    let content = yield* fs
      .readFileString(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));

    // Templates use main.mts as the canonical filename in comments.
    // When the target is main.ts, rewrite those references.
    if (mainFilename === "main.ts") {
      content = content.replace(/main\.mts/g, "main.ts");
    }

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

    // Replace the sandbox provider. Templates always use `docker` as the
    // placeholder, where the registry name doubles as both the factory function
    // name and the `/sandboxes/<name>` import subpath segment. A single
    // case-sensitive word-boundary replace therefore rewrites the named import,
    // the import subpath, and every factory call site — and is a no-op when
    // docker is selected.
    content = content.replace(/\bdocker\b/g, sandboxProvider.name);

    yield* fs
      .writeFileString(mainTsPath, content)
      .pipe(Effect.mapError((e) => new Error(e.message)));
  });

/**
 * When the user opted out of the Sandcastle label, strip ` --label Sandcastle`
 * from all `.md` files in the scaffolded config directory so that `gh issue list`
 * commands work without a label filter.
 */
const rewritePromptFiles = (
  configDir: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    yield* Effect.all(
      mdFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          const content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const updated = content.replace(/ --label Sandcastle/g, "");
          if (updated !== content) {
            yield* fs
              .writeFileString(filePath, updated)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });

/** Text file extensions eligible for `{{KEY}}` template argument substitution. */
const TEXT_FILE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".env",
  ".example",
  // Dockerfile / Containerfile have no extension — handled by name check below
]);

const isTextFile = (filename: string): boolean => {
  if (
    filename === "Dockerfile" ||
    filename === "Containerfile" ||
    filename === ".gitignore"
  )
    return true;
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return TEXT_FILE_EXTENSIONS.has(filename.slice(dotIdx));
};

/**
 * Replace `{{KEY}}` template arguments from the issue tracker's
 * `templateArgs` map in all text files in the scaffolded config directory.
 */
const substituteTemplateArgs = (
  configDir: string,
  issueTracker: IssueTrackerEntry,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const textFiles = files.filter(isTextFile);
    yield* Effect.all(
      textFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          let content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const original = content;
          for (const [key, value] of Object.entries(
            issueTracker.templateArgs,
          )) {
            content = content.replace(
              new RegExp(`\\{\\{${key}\\}\\}`, "g"),
              value,
            );
          }
          if (content !== original) {
            yield* fs
              .writeFileString(filePath, content)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });

/**
 * Build the `SETUP_ISSUE_TRACKER.md` prompt scaffolded for the `custom` issue
 * tracker. It addresses the user's coding agent and walks it through wiring up
 * the tracker by editing the scaffolded files in place. The build command is
 * provider-parameterized so it names the actual CLI namespace (docker/podman).
 */
const buildSetupIssueTrackerDoc = (cliNamespace: string): string =>
  `# Set up your custom issue tracker

You are a coding agent. Finish wiring up the **custom issue tracker** for this Sandcastle project. It was scaffolded in a deliberately broken-until-configured state: until you complete the steps below, every Sandcastle run hard-fails with a pointer back to this file.

## Goal

Wire up the issue tracker so the scaffolded prompts can **list**, **view**, and **close** tasks. There is no runtime abstraction to implement — the tracker commands are baked into the scaffolded files, so you edit those files **in place**.

## 1. Interview the user

Ask the user:

- Which issue tracker do they use (e.g. Jira, Linear, a GitHub repo other than this one, an internal API)?
- How should the sandbox authenticate — a CLI that is already logged in, or an API token? If a token, what is the environment variable name?

## 2. Produce three commands

Work out, together with the user, the shell commands for:

- **list** — print all open tasks **as JSON** (match the shape the built-in trackers emit: an array of objects, each with at least an id/number, title, and body). This is what the agent reads at the start of every iteration.
- **view** \`<ID>\` — show a single task by id.
- **close** \`<ID>\` — close a single task by id.

## 3. Edit the scaffolded files in place

- **Dockerfile / Containerfile** — replace the line

  \`\`\`
  ${CUSTOM_TRACKER_TOOLS}
  \`\`\`

  with the install steps for your tracker's CLI (if it needs one).

- **Prompt files (\`.sandcastle/*.md\`)** — replace the sentinel

  \`\`\`
  ${CUSTOM_LIST_TASKS_SENTINEL}
  \`\`\`

  with your **list** command. In the prompt file the sentinel sits inside a Sandcastle **shell expression** — a leading \`!\` followed by the command in backticks — whose output is injected into the prompt before each run. Keep that \`!\` and the surrounding backticks; replace only the command between them, and **remove the \`exit 1\`** (leaving it keeps every run hard-failing). Then replace the \`${CUSTOM_VIEW_TASK_MARKER}\` and \`${CUSTOM_CLOSE_TASK_MARKER}\` markers with your **view** and **close** commands.

- **\`.env.example\`** — replace the \`# TODO\` block with the real env var(s) your tracker needs, then tell the user to set them in \`.sandcastle/.env\`.

## 4. Build the image

Once the files are wired up, build the sandbox image:

\`\`\`
sandcastle ${cliNamespace} build-image
\`\`\`

## 5. Verify

Run your **list** command inside the built image and confirm it returns the open tasks as JSON. If it errors, fix the command or the auth and rebuild.
`;

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
  agent: AgentEntry;
  model: string;
  templateName?: string;
  createLabel?: boolean;
  issueTracker?: IssueTrackerEntry;
  sandboxProvider?: SandboxProviderEntry;
}

export interface ScaffoldResult {
  mainFilename: string;
}

/**
 * Detect whether the project's package.json has `"type": "module"`.
 * If so, we can use plain `.ts`; otherwise we use `.mts` to ensure ESM.
 */
const detectMainFilename = (
  repoDir: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(repoDir, "package.json");
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return "main.mts";
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    try {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      return pkg["type"] === "module" ? "main.ts" : "main.mts";
    } catch {
      return "main.mts";
    }
  });

export const scaffold = (
  repoDir: string,
  options: ScaffoldOptions,
): Effect.Effect<ScaffoldResult, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const {
      agent,
      model,
      templateName = "blank",
      createLabel = true,
      issueTracker = ISSUE_TRACKER_REGISTRY[0]!, // default: github-issues
      sandboxProvider = SANDBOX_PROVIDER_REGISTRY[0]!, // default: docker
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

    const mainFilename = yield* detectMainFilename(repoDir);

    yield* fs
      .makeDirectory(configDir, { recursive: false })
      .pipe(Effect.mapError((e) => new Error(e.message)));

    const templateDir = yield* getTemplateDir(templateName);

    // Build .env.example from agent + issue tracker env blocks
    const envExampleParts = [agent.envExample];
    if (issueTracker.envExample) {
      envExampleParts.push(issueTracker.envExample);
    }
    const envExampleContent = envExampleParts.join("\n") + "\n";

    yield* Effect.all(
      [
        fs
          .writeFileString(
            join(configDir, sandboxProvider.containerfileName),
            agent.dockerfileTemplate,
          )
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".gitignore"), GITIGNORE)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".env.example"), envExampleContent)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        copyTemplateFiles(templateDir, configDir, mainFilename),
      ],
      { concurrency: "unbounded" },
    );

    // Rewrite main file with the selected agent factory, model, and sandbox provider
    yield* rewriteMainTs(
      configDir,
      agent,
      model,
      sandboxProvider,
      mainFilename,
    );

    // Replace issue tracker template arguments in all text files (must run before label stripping)
    yield* substituteTemplateArgs(configDir, issueTracker);

    // Strip --label Sandcastle from prompt files when the user declined label creation
    if (!createLabel) {
      yield* rewritePromptFiles(configDir);
    }

    // For the custom issue tracker, drop the setup prompt the user feeds to
    // their coding agent. Written after substituteTemplateArgs so it isn't
    // clobbered and references the resolved sentinel markers the agent finds
    // (not the {{KEY}} names, which are gone by now).
    if (issueTracker.name === "custom") {
      yield* fs
        .writeFileString(
          join(configDir, SETUP_ISSUE_TRACKER_DOC),
          buildSetupIssueTrackerDoc(sandboxProvider.cliNamespace),
        )
        .pipe(Effect.mapError((e) => new Error(e.message)));
    }

    return { mainFilename };
  });
