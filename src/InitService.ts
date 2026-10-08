import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { InitError } from "./errors.js";

const gitignoreFor = (options: {
  readonly isolatedCodexHome: boolean;
  readonly codeGraph: boolean;
  readonly projectCachePath?: string;
}): string =>
  [
    ".env",
    "logs/",
    "runs/",
    "worktrees/",
    ...(options.isolatedCodexHome ? ["codex-home/"] : []),
    ...(options.codeGraph ? ["cache/codegraph/"] : []),
    ...(options.projectCachePath
      ? [`${options.projectCachePath.replace(/^\.sandcastle\//, "")}/`]
      : []),
    "",
  ].join("\n");

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
  /** Reuse another template's files before applying profile-specific rewrites. */
  sourceTemplate?: string;
  /** Agent required by a provider-specific template. */
  requiredAgent?: string;
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
  {
    name: "codex-afk",
    description:
      "Parallel planner/reviewer with isolated ChatGPT OAuth and branch-local CodeGraph",
    dependencies: ["zod"],
    sourceTemplate: "parallel-planner-with-review",
    requiredAgent: "codex",
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
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
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
    defaultModel: "claude-opus-4-8",
    factoryImport: "claudeCode",
    dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
    envExample: `# Claude Code OAuth token — get one by running \`claude setup-token\` on your host.
# Lets the agent use your Claude subscription instead of an API key.
CLAUDE_CODE_OAUTH_TOKEN=
# Or use an Anthropic API key instead — uncomment and fill in:
# ANTHROPIC_API_KEY=`,
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
    readonly PLANNER_LIST_TASKS_COMMAND: string;
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
      PLANNER_LIST_TASKS_COMMAND: `node .sandcastle/github-planner-inventory.cjs --label Sandcastle`,
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
      PLANNER_LIST_TASKS_COMMAND: "bd ready --json",
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
      PLANNER_LIST_TASKS_COMMAND: CUSTOM_LIST_TASKS_SENTINEL,
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
    const lines = [
      "Next steps:",
      `1. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
    ];
    if (agent.name === "claude-code") {
      lines.push(
        "   To use your Claude subscription instead of an API key, run `claude setup-token` on your host and paste the result into CLAUDE_CODE_OAUTH_TOKEN.",
      );
    }
    lines.push(
      "2. Read and customize .sandcastle/prompt.md to describe what you want the agent to do",
      `3. Customize .sandcastle/${mainFilename} — it uses the JS API (\`run()\`) to control how the agent runs`,
      `4. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      "5. Run `npm run sandcastle` to start the agent",
    );
    return lines;
  } else if (template === "codex-afk") {
    return [
      "Next steps:",
      "1. Set GitHub issue-tracker credentials in .sandcastle/.env (see .sandcastle/.env.example)",
      `2. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      "3. Review .sandcastle/project.json and the generated .sandcastle/FEEDBACK_LOOPS.md commands",
      "4. Review and complete the deterministic .sandcastle/CODING_STANDARDS.md draft",
      `5. Install the planner schema validator if needed (${addDependencyCommand(packageManager, "zod")})`,
      "6. Run .sandcastle/scripts/verify-affected.sh against a known base SHA to validate the project gates",
      "7. Build the sandbox image if init did not build it, then run `npm run sandcastle`",
    ];
  } else {
    const hasReviewer = template.includes("review");
    const usesPlanSchema = getTemplateDependencies(template).includes("zod");
    let step = 1;
    const lines: string[] = [
      "Next steps:",
      `${step++}. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
    ];
    if (agent.name === "claude-code") {
      lines.push(
        "   To use your Claude subscription instead of an API key, run `claude setup-token` on your host and paste the result into CLAUDE_CODE_OAUTH_TOKEN.",
      );
    }
    lines.push(
      `${step++}. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      `${step++}. Templates use \`copyToWorktree: ["node_modules"]\` to copy your host node_modules into the sandbox for fast startup — the \`npm install\` in the onSandboxReady hook is a safety net for platform-specific binaries. Adjust both if you use a different package manager`,
    );
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
    return join(getTemplatesDir(), template!.sourceTemplate ?? templateName);
  });

const CODEX_CHATGPT_CONFIG = `cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
`;

const CODEX_CHATGPT_ENV_EXAMPLE = `# Codex authenticates with an isolated ChatGPT subscription login.
# Run \`sandcastle init --profile codex-afk\` interactively, or run:
# CODEX_HOME=.sandcastle/codex-home codex login
`;

interface NodeNpmProjectProfile {
  readonly schemaVersion: 1;
  readonly projectType: "node";
  readonly packageManager: "npm";
  readonly bootstrap: { readonly command: string };
  readonly cache: {
    readonly hostPath: string;
    readonly sandboxPath: string;
  };
  readonly rootPackage: {
    readonly cwd: ".";
    readonly focusedTestHint: string;
    readonly authoritativeGates: readonly string[];
  };
}

interface AndroidGradleProjectProfile {
  readonly schemaVersion: 1;
  readonly projectType: "android";
  readonly buildTool: "gradle";
  readonly javaVersion: 17;
  readonly androidSdk: {
    readonly compileSdk: number;
    readonly packages: readonly string[];
  };
  readonly bootstrap: { readonly command: string };
  readonly cache: {
    readonly hostPath: string;
    readonly sandboxPath: string;
  };
  readonly rootProject: {
    readonly cwd: ".";
    readonly focusedTestHint: string;
    readonly authoritativeGates: readonly string[];
  };
}

type CodexAfkProjectProfile =
  | NodeNpmProjectProfile
  | AndroidGradleProjectProfile;

interface DetectedCodexAfkProject {
  readonly profile: CodexAfkProjectProfile;
  readonly sources: readonly string[];
}

const NODE_STANDARDS_SOURCE_CANDIDATES = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CONTEXT.md",
  "README.md",
  "package.json",
  "tsconfig.json",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc",
  ".prettierrc",
  "vitest.config.ts",
  "jest.config.js",
] as const;

const NON_NODE_PROJECT_MARKERS = [
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
] as const;

const ANDROID_BUILD_FILE_CANDIDATES = [
  "build.gradle",
  "build.gradle.kts",
  "app/build.gradle",
  "app/build.gradle.kts",
] as const;

const ANDROID_STANDARDS_SOURCE_CANDIDATES = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CONTEXT.md",
  "README.md",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "gradle/libs.versions.toml",
  "app/build.gradle",
  "app/build.gradle.kts",
] as const;

const readExistingFiles = (
  repoDir: string,
  candidates: readonly string[],
): Effect.Effect<Map<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = new Map<string, string>();
    for (const candidate of candidates) {
      const path = join(repoDir, candidate);
      const exists = yield* fs
        .exists(path)
        .pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      const content = yield* fs
        .readFileString(path)
        .pipe(Effect.orElseSucceed(() => ""));
      files.set(candidate, content);
    }
    return files;
  });

const parseAndroidCompileSdk = (
  buildFiles: ReadonlyMap<string, string>,
): number | undefined => {
  for (const content of buildFiles.values()) {
    const direct = content.match(
      /\bcompileSdk(?:Version)?\s*(?:=|\s)\s*["']?(\d+)["']?/,
    );
    if (direct?.[1]) return Number(direct[1]);
  }

  const versionCatalog = buildFiles.get("gradle/libs.versions.toml");
  const catalog = versionCatalog?.match(
    /^\s*compile[-_]?sdk\s*=\s*["']?(\d+)["']?\s*$/im,
  );
  return catalog?.[1] ? Number(catalog[1]) : undefined;
};

const detectAndroidGradleProjectProfile = (
  repoDir: string,
): Effect.Effect<
  DetectedCodexAfkProject | undefined,
  Error,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const gradlewExists = yield* fs
      .exists(join(repoDir, "gradlew"))
      .pipe(Effect.orElseSucceed(() => false));
    const rootEntries = yield* fs
      .readDirectory(repoDir)
      .pipe(Effect.orElseSucceed((): string[] => []));
    const moduleBuildFiles = rootEntries.flatMap((entry) => [
      `${entry}/build.gradle`,
      `${entry}/build.gradle.kts`,
    ]);
    const buildFiles = yield* readExistingFiles(repoDir, [
      ...ANDROID_BUILD_FILE_CANDIDATES,
      ...moduleBuildFiles,
      "gradle/libs.versions.toml",
    ]);
    const androidBuild = [...buildFiles.values()].some(
      (content) =>
        /com\.android\.(?:application|library|test)/.test(content) ||
        /\bandroid\s*\{/.test(content),
    );
    if (!gradlewExists || !androidBuild) return undefined;

    const compileSdk = parseAndroidCompileSdk(buildFiles);
    if (compileSdk === undefined) {
      return yield* Effect.fail(
        new Error(
          "Android/Gradle project detected, but compileSdk could not be resolved from Gradle files or gradle/libs.versions.toml.",
        ),
      );
    }

    const standardsFiles = yield* readExistingFiles(repoDir, [
      ...ANDROID_STANDARDS_SOURCE_CANDIDATES,
      ...moduleBuildFiles,
    ]);
    return {
      profile: {
        schemaVersion: 1,
        projectType: "android",
        buildTool: "gradle",
        javaVersion: 17,
        androidSdk: {
          compileSdk,
          packages: [
            "platform-tools",
            `platforms;android-${compileSdk}`,
            `build-tools;${compileSdk}.0.0`,
          ],
        },
        bootstrap: { command: "./gradlew --no-daemon help" },
        cache: {
          hostPath: ".sandcastle/cache/gradle",
          sandboxPath: "/home/agent/.gradle",
        },
        rootProject: {
          cwd: ".",
          focusedTestHint:
            './gradlew :<module>:testDebugUnitTest --tests "<test-class>"',
          authoritativeGates: [
            "./gradlew test",
            "./gradlew lint",
            "./gradlew assembleDebug",
          ],
        },
      },
      sources: [...standardsFiles.keys()],
    };
  });

const detectNodeNpmProjectProfile = (
  repoDir: string,
): Effect.Effect<
  { readonly profile: NodeNpmProjectProfile; readonly sources: string[] },
  Error,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const packagePath = join(repoDir, "package.json");
    const hasPackageJson = yield* fs
      .exists(packagePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasPackageJson) {
      for (const marker of NON_NODE_PROJECT_MARKERS) {
        const exists = yield* fs
          .exists(join(repoDir, marker))
          .pipe(Effect.orElseSucceed(() => false));
        if (exists) {
          return yield* Effect.fail(
            new Error(
              `The codex-afk project profile supports Node/npm or Android/Gradle; detected ${marker}.`,
            ),
          );
        }
      }
    }
    const packageManager = yield* detectPackageManager(repoDir);
    if (packageManager !== "npm") {
      return yield* Effect.fail(
        new Error(
          `The codex-afk project profile currently supports npm; detected ${packageManager}.`,
        ),
      );
    }

    const packageJson = yield* fs
      .readFileString(packagePath)
      .pipe(Effect.orElseSucceed(() => "{}"));
    let scripts: Record<string, string> = {};
    try {
      const parsed = JSON.parse(packageJson) as { scripts?: unknown };
      if (
        typeof parsed.scripts === "object" &&
        parsed.scripts !== null &&
        !Array.isArray(parsed.scripts)
      ) {
        scripts = Object.fromEntries(
          Object.entries(parsed.scripts).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    } catch {
      // A malformed package.json is handled like a project with no scripts;
      // the generated verification script fails closed below.
    }

    const hasLockfile = yield* fs
      .exists(join(repoDir, "package-lock.json"))
      .pipe(Effect.orElseSucceed(() => false));
    const authoritativeGates = [
      ...(scripts.typecheck ? ["npm run typecheck"] : []),
      ...(scripts.test ? ["npm test"] : []),
      ...(scripts.build ? ["npm run build"] : []),
    ];
    const focusedTestHint = scripts.test?.includes("vitest")
      ? "npm test -- <affected-test-files> --run"
      : "npm test -- <affected-test-files>";
    const sources: string[] = [];
    for (const candidate of NODE_STANDARDS_SOURCE_CANDIDATES) {
      const exists = yield* fs
        .exists(join(repoDir, candidate))
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) sources.push(candidate);
    }

    return {
      profile: {
        schemaVersion: 1,
        projectType: "node",
        packageManager: "npm",
        bootstrap: { command: hasLockfile ? "npm ci" : "npm install" },
        cache: {
          hostPath: ".sandcastle/cache/npm",
          sandboxPath: "/home/agent/.npm",
        },
        rootPackage: {
          cwd: ".",
          focusedTestHint,
          authoritativeGates,
        },
      },
      sources,
    };
  });

const detectCodexAfkProjectProfile = (
  repoDir: string,
): Effect.Effect<DetectedCodexAfkProject, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const android = yield* detectAndroidGradleProjectProfile(repoDir);
    if (android !== undefined) return android;
    return yield* detectNodeNpmProjectProfile(repoDir);
  });

const renderFeedbackLoops = (profile: NodeNpmProjectProfile): string => {
  const gates =
    profile.rootPackage.authoritativeGates.length > 0
      ? profile.rootPackage.authoritativeGates
          .map((command) => `- \`${command}\``)
          .join("\n")
      : "- No authoritative gates were detected. Configure this file and the verification scripts before AFK execution.";
  return `# Feedback Loops

This file is generated from \`.sandcastle/project.json\`. Commands are executed
inside the sandbox from the repository root. Update the project profile and
regenerate these artifacts when the package layout or build system changes.

## Bootstrap

- Command: \`${profile.bootstrap.command}\`
- Cache: \`${profile.cache.hostPath}\` → \`${profile.cache.sandboxPath}\`

## Root Package

- Working directory: \`${profile.rootPackage.cwd}\`
- Focused test: \`${profile.rootPackage.focusedTestHint}\`

Authoritative gates:

${gates}

## Cumulative Merge Gate

Run \`.sandcastle/scripts/verify-affected.sh <batch-base-sha>\`. It validates
the complete diff from the immutable batch base before tasks may be closed.
`;
};

const renderCodingStandardsDraft = (sources: readonly string[]): string => {
  const sourceList =
    sources.length > 0
      ? sources.map((source) => `- \`${source}\``).join("\n")
      : "- No repository standards sources were detected.";
  return `# Coding Standards

This is a deterministic draft created during Sandcastle init. Review and
customize it before the first AFK run. Do not add executable feedback commands
here; they belong in \`.sandcastle/FEEDBACK_LOOPS.md\`.

## Detected Sources of Truth

${sourceList}

Read the applicable sources above before changing code. When sources conflict,
the more specific module-level instruction wins.

## Project-Specific Rules

<!-- Record architecture boundaries, naming, error handling, security,
persistence, compatibility, testing conventions, and generated-file rules. -->
`;
};

const renderShellScript = (commands: readonly string[]): string =>
  ["#!/usr/bin/env bash", "set -euo pipefail", "", ...commands, ""].join("\n");

const scaffoldNodeNpmProjectProfile = (
  configDir: string,
  detected: {
    readonly profile: NodeNpmProjectProfile;
    readonly sources: readonly string[];
  },
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { profile, sources } = detected;
    const scriptsDir = join(configDir, "scripts");
    yield* fs
      .makeDirectory(scriptsDir, { recursive: true })
      .pipe(Effect.mapError((e) => new Error(e.message)));

    const verifyCommands =
      profile.rootPackage.authoritativeGates.length > 0
        ? [
            'repo_root="$(git rev-parse --show-toplevel)"',
            'cd "$repo_root"',
            ...profile.rootPackage.authoritativeGates,
          ]
        : [
            'echo "No authoritative feedback gates were detected. Configure .sandcastle/project.json before AFK execution." >&2',
            "exit 1",
          ];
    const files = [
      {
        path: join(configDir, "project.json"),
        content: `${JSON.stringify(profile, null, 2)}\n`,
        mode: 0o644,
      },
      {
        path: join(configDir, "FEEDBACK_LOOPS.md"),
        content: renderFeedbackLoops(profile),
        mode: 0o644,
      },
      {
        path: join(configDir, "CODING_STANDARDS.md"),
        content: renderCodingStandardsDraft(sources),
        mode: 0o644,
      },
      {
        path: join(scriptsDir, "bootstrap.sh"),
        content: renderShellScript([
          'repo_root="$(git rev-parse --show-toplevel)"',
          'cd "$repo_root"',
          profile.bootstrap.command,
        ]),
        mode: 0o755,
      },
      {
        path: join(scriptsDir, "verify-package.sh"),
        content: renderShellScript([
          'package_name="${1:-root}"',
          'if test "$package_name" != "root"; then',
          '  echo "Unknown package: $package_name" >&2',
          "  exit 1",
          "fi",
          ...verifyCommands,
        ]),
        mode: 0o755,
      },
      {
        path: join(scriptsDir, "verify-affected.sh"),
        content: renderShellScript([
          'base_sha="${1:?usage: verify-affected.sh <batch-base-sha>}"',
          'git cat-file -e "${base_sha}^{commit}"',
          'changed_files="$(git diff --name-only "$base_sha"...HEAD)"',
          'if test -z "$changed_files"; then',
          '  echo "No changed files since $base_sha."',
          "  exit 0",
          "fi",
          'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
          '"$script_dir/verify-package.sh" root',
          "git diff --check",
        ]),
        mode: 0o755,
      },
    ];

    for (const file of files) {
      yield* fs
        .writeFileString(file.path, file.content)
        .pipe(Effect.mapError((e) => new Error(e.message)));
      yield* fs
        .chmod(file.path, file.mode)
        .pipe(Effect.mapError((e) => new Error(e.message)));
    }
  });

const renderAndroidFeedbackLoops = (
  profile: AndroidGradleProjectProfile,
): string => `# Feedback Loops

This file is generated from \`.sandcastle/project.json\` for an Android/Gradle
project. Commands run inside the sandbox from the repository root.

## Bootstrap

- Command: \`${profile.bootstrap.command}\`
- Gradle cache: \`${profile.cache.hostPath}\` → \`${profile.cache.sandboxPath}\`
- Android compile SDK: \`${profile.androidSdk.compileSdk}\`

## Root Project

- Working directory: \`${profile.rootProject.cwd}\`
- Focused unit test: \`${profile.rootProject.focusedTestHint}\`

Authoritative gates that do not require an emulator:

${profile.rootProject.authoritativeGates.map((command) => `- \`${command}\``).join("\n")}

Instrumentation tests require an explicitly configured emulator or device and
are therefore not part of the default AFK completion gate.

## Cumulative Merge Gate

Run \`.sandcastle/scripts/verify-affected.sh <batch-base-sha>\`. It validates
the complete diff from the immutable batch base before tasks may be closed.
`;

const scaffoldAndroidGradleProjectProfile = (
  configDir: string,
  detected: {
    readonly profile: AndroidGradleProjectProfile;
    readonly sources: readonly string[];
  },
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { profile, sources } = detected;
    const scriptsDir = join(configDir, "scripts");
    yield* fs
      .makeDirectory(scriptsDir, { recursive: true })
      .pipe(Effect.mapError((e) => new Error(e.message)));

    const projectCommands = [
      'repo_root="$(git rev-parse --show-toplevel)"',
      'cd "$repo_root"',
      ...profile.rootProject.authoritativeGates,
    ];
    const files = [
      {
        path: join(configDir, "project.json"),
        content: `${JSON.stringify(profile, null, 2)}\n`,
        mode: 0o644,
      },
      {
        path: join(configDir, "FEEDBACK_LOOPS.md"),
        content: renderAndroidFeedbackLoops(profile),
        mode: 0o644,
      },
      {
        path: join(configDir, "CODING_STANDARDS.md"),
        content: renderCodingStandardsDraft(sources),
        mode: 0o644,
      },
      {
        path: join(scriptsDir, "bootstrap.sh"),
        content: renderShellScript([
          'repo_root="$(git rev-parse --show-toplevel)"',
          'cd "$repo_root"',
          "test -x ./gradlew || chmod +x ./gradlew",
          profile.bootstrap.command,
        ]),
        mode: 0o755,
      },
      {
        path: join(scriptsDir, "verify-package.sh"),
        content: renderShellScript([
          'project_name="${1:-root}"',
          'if test "$project_name" != "root"; then',
          '  echo "Unknown Android project: $project_name" >&2',
          "  exit 1",
          "fi",
          ...projectCommands,
        ]),
        mode: 0o755,
      },
      {
        path: join(scriptsDir, "verify-affected.sh"),
        content: renderShellScript([
          'base_sha="${1:?usage: verify-affected.sh <batch-base-sha>}"',
          'git cat-file -e "${base_sha}^{commit}"',
          'changed_files="$(git diff --name-only "$base_sha"...HEAD)"',
          'if test -z "$changed_files"; then',
          '  echo "No changed files since $base_sha."',
          "  exit 0",
          "fi",
          'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
          '"$script_dir/verify-package.sh" root',
          "git diff --check",
        ]),
        mode: 0o755,
      },
    ];

    for (const file of files) {
      yield* fs
        .writeFileString(file.path, file.content)
        .pipe(Effect.mapError((e) => new Error(e.message)));
      yield* fs
        .chmod(file.path, file.mode)
        .pipe(Effect.mapError((e) => new Error(e.message)));
    }
  });

const validateCodeGraphVersion = (version: string): string => {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error(`Invalid CodeGraph version: "${version}"`);
  }
  return version;
};

const addCodeGraphToContainerfile = (
  containerfile: string,
  version: string,
): string => {
  const install = "RUN npm install -g @openai/codex";
  if (!containerfile.includes(install)) {
    throw new Error("The codex-afk template requires the Codex Dockerfile.");
  }
  const withRuntimeTools = containerfile.replace(
    "{{ISSUE_TRACKER_TOOLS}}",
    `# Baseline tools used by Codex recovery and CodeGraph navigation
RUN apt-get update && apt-get install -y \\
  build-essential \\
  python3 \\
  python-is-python3 \\
  ripgrep \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}`,
  );
  const installWithCodeGraph = `${install} @colbymchenry/codegraph@${validateCodeGraphVersion(version)}`;
  return withRuntimeTools.replace(
    install,
    `${installWithCodeGraph}
RUN codex --version && codegraph version && python --version && npm --version`,
  );
};

const addAndroidToolchainToContainerfile = (
  containerfile: string,
  profile: AndroidGradleProjectProfile,
): string => {
  const androidBase = containerfile.replace(
    "FROM node:22-bookworm",
    "ARG ANDROID_SANDBOX_PLATFORM=linux/amd64\nFROM --platform=${ANDROID_SANDBOX_PLATFORM} node:22-bookworm",
  );
  const uidAnchor = "# Build-args for UID/GID alignment:";
  if (!androidBase.includes(uidAnchor)) {
    throw new Error(
      "The Android profile requires the standard Codex Dockerfile.",
    );
  }
  const packages = profile.androidSdk.packages
    .map((value) => `"${value}"`)
    .join(" ");
  const androidToolchain = `# Android/Gradle build toolchain
ARG ANDROID_COMMAND_LINE_TOOLS_VERSION=11076708
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="\${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:\${ANDROID_SDK_ROOT}/platform-tools:\${PATH}"

RUN apt-get update && apt-get install -y \\
  openjdk-${profile.javaVersion}-jdk-headless \\
  unzip \\
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "\${ANDROID_SDK_ROOT}/cmdline-tools" \\
  && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-\${ANDROID_COMMAND_LINE_TOOLS_VERSION}_latest.zip" -o /tmp/android-command-line-tools.zip \\
  && unzip -q /tmp/android-command-line-tools.zip -d "\${ANDROID_SDK_ROOT}/cmdline-tools" \\
  && mv "\${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools" "\${ANDROID_SDK_ROOT}/cmdline-tools/latest" \\
  && rm /tmp/android-command-line-tools.zip

RUN yes | sdkmanager --licenses >/dev/null
RUN sdkmanager ${packages}

RUN java -version && sdkmanager --version

`;
  return androidBase.replace(uidAnchor, `${androidToolchain}${uidAnchor}`);
};

const replaceRequired = (
  content: string,
  search: string,
  replacement: string,
): string => {
  if (!content.includes(search)) {
    throw new Error(`codex-afk template anchor is missing: ${search}`);
  }
  return content.replace(search, replacement);
};

const rewriteCodexAfkMain = (
  configDir: string,
  mainFilename: string,
  model: string,
  project: CodexAfkProjectProfile,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mainPath = join(configDir, mainFilename);
    let content = yield* fs
      .readFileString(mainPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));

    // rewriteMainTs has already converted the template's placeholder factory
    // to Codex. Collapse only those original call sites before injecting the
    // shared provider factory below.
    content = content.replace(/sandcastle\.codex\([^)]+\)/g, "codexAgent()");
    const reviewerCall =
      /name: "reviewer",\s*maxIterations: 1,\s*agent: codexAgent\(\),/.exec(
        content,
      )?.[0];
    if (!reviewerCall)
      return yield* Effect.fail(
        new InitError({
          message: "codex-afk reviewer factory anchor is missing",
        }),
      );
    content = replaceRequired(
      content,
      reviewerCall,
      reviewerCall.replace("codexAgent()", 'codexAgent("xhigh")'),
    );

    content = replaceRequired(
      content,
      `import { execFile } from "node:child_process";
import { z } from "zod";`,
      `import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";`,
    );

    const cachePrefix = project.projectType === "android" ? "GRADLE" : "NPM";
    const sandboxProjectEnv =
      project.projectType === "android"
        ? ', ANDROID_HOME: "/opt/android-sdk", ANDROID_SDK_ROOT: "/opt/android-sdk"'
        : "";
    const runtime = `const BASE_BRANCH = (await runHost("git", ["branch", "--show-current"])).trim();

if (!BASE_BRANCH) {
  throw new Error("Sandcastle requires a named Git branch, not detached HEAD.");
}

const CODEX_HOME_HOST = ".sandcastle/codex-home";
const CODEX_HOME_SANDBOX = "/home/agent/.codex";
const CODEX_CONFIG_HOST = \`\${CODEX_HOME_HOST}/config.toml\`;
const CODING_STANDARDS_HOST = ".sandcastle/CODING_STANDARDS.md";
const CODING_STANDARDS_SANDBOX = "/home/agent/CODING_STANDARDS.md";
const FEEDBACK_LOOPS_HOST = ".sandcastle/FEEDBACK_LOOPS.md";
const FEEDBACK_LOOPS_SANDBOX = "/home/agent/FEEDBACK_LOOPS.md";
const ${cachePrefix}_CACHE_HOST = ${JSON.stringify(project.cache.hostPath)};
const ${cachePrefix}_CACHE_SANDBOX = ${JSON.stringify(project.cache.sandboxPath)};
const CODEGRAPH_CACHE_ROOT_HOST = ".sandcastle/cache/codegraph";
const CODEGRAPH_SEED_DATABASE_HOST = ".codegraph/codegraph.db";
const CODEGRAPH_CACHE_SANDBOX = "/home/agent/workspace/.codegraph";

mkdirSync(CODEX_HOME_HOST, { recursive: true, mode: 0o700 });
chmodSync(CODEX_HOME_HOST, 0o700);
if (!existsSync(CODEX_CONFIG_HOST)) {
  writeFileSync(
    CODEX_CONFIG_HOST,
    'cli_auth_credentials_store = "file"\\nforced_login_method = "chatgpt"\\n',
    { mode: 0o600 },
  );
}
chmodSync(CODEX_CONFIG_HOST, 0o600);
mkdirSync(${cachePrefix}_CACHE_HOST, { recursive: true });

const codeGraphSyncCommand =
  "if test -f .codegraph/codegraph.db; then codegraph sync --quiet .; else codegraph init .; fi";

const codexSandbox = (branch: string, extraEnv: Record<string, string> = trackerEnvironment) =>
  docker({
    mounts: [
      { hostPath: CODEX_HOME_HOST, sandboxPath: CODEX_HOME_SANDBOX },
      {
        hostPath: CODING_STANDARDS_HOST,
        sandboxPath: CODING_STANDARDS_SANDBOX,
        readonly: true,
      },
      {
        hostPath: FEEDBACK_LOOPS_HOST,
        sandboxPath: FEEDBACK_LOOPS_SANDBOX,
        readonly: true,
      },
      { hostPath: ${cachePrefix}_CACHE_HOST, sandboxPath: ${cachePrefix}_CACHE_SANDBOX },
      {
        hostPath: sandcastle.prepareCodeGraphCache({
          cacheRoot: CODEGRAPH_CACHE_ROOT_HOST,
          branch,
          seedDatabase: CODEGRAPH_SEED_DATABASE_HOST,
        }),
        sandboxPath: CODEGRAPH_CACHE_SANDBOX,
      },
    ],
    env: { HOME: "/home/agent", CODEX_HOME: CODEX_HOME_SANDBOX${sandboxProjectEnv}, ...extraEnv },
  });

const codexAgent = (effort: "low" | "medium" | "high" | "xhigh" = "high") =>
  sandcastle.codex(${JSON.stringify(model)}, {
    effort,
    sessionStorage: {
      hostSessionsDir: \`\${CODEX_HOME_HOST}/sessions\`,
      sandboxSessionsDir: \`\${CODEX_HOME_SANDBOX}/sessions\`,
    },
  });

async function syncCodeGraph(sandbox: sandcastle.Sandbox): Promise<void> {
  const result = await sandbox.exec(codeGraphSyncCommand);
  if (result.exitCode !== 0) {
    throw new Error(\`CodeGraph sync failed: \${result.stderr || result.stdout}\`);
  }
}`;

    content = replaceRequired(
      content,
      "const MAX_ITERATIONS = 10;",
      `const MAX_ITERATIONS = 10;\n${runtime}`,
    );
    content = replaceRequired(
      content,
      `const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};`,
      `const hooks = {
  sandbox: {
    onSandboxReady: [
      { command: "codex login status" },
      { command: "test -r /home/agent/CODING_STANDARDS.md" },
      { command: "test -r /home/agent/FEEDBACK_LOOPS.md" },
      { command: codeGraphSyncCommand, timeoutMs: 120_000 },
      { command: "bash .sandcastle/scripts/bootstrap.sh" },
    ],
  },
};`,
    );

    content = replaceRequired(
      content,
      "sandbox: docker({ env: trackerEnvironment }),",
      "sandbox: codexSandbox(BASE_BRANCH),",
    );
    content = replaceRequired(
      content,
      "sandbox: docker({ env: readinessEnvironment })",
      "sandbox: codexSandbox(branch, readinessEnvironment)",
    );
    content = replaceRequired(
      content,
      "sandbox: docker({ env: trackerEnvironment }),",
      "sandbox: codexSandbox(issue.branch),",
    );
    content = replaceRequired(
      content,
      "sandbox: docker({ env: trackerEnvironment }),",
      "sandbox: codexSandbox(BASE_BRANCH),",
    );
    const reviewStart =
      /if \(sandbox && implement\.commits\.length > 0\) \{\s*/.exec(
        content,
      )?.[0];
    if (!reviewStart)
      return yield* Effect.fail(
        new InitError({ message: "codex-afk reviewer sync anchor is missing" }),
      );
    content = replaceRequired(
      content,
      reviewStart,
      `${reviewStart}await syncCodeGraph(sandbox);\n${reviewStart.match(/\s*$/)?.[0] ?? ""}`,
    );
    content = replaceRequired(
      content,
      `// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];`,
      `// Install dependencies inside the Linux sandbox from the lockfile. The
// package-manager download cache is mounted separately by codexSandbox().
const copyToWorktree: string[] = [];`,
    );

    yield* fs
      .writeFileString(mainPath, content)
      .pipe(Effect.mapError((e) => new Error(e.message)));
  });

const configureCodexAfkPrompts = (
  configDir: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const guidance = `## CODEGRAPH NAVIGATION

Use the synchronized branch-local index before broad text searches:

\`\`\`bash
codegraph explore "{{ISSUE_TITLE}}"
codegraph query "<relevant symbol>"
codegraph impact "<public symbol being changed>"
\`\`\`

Use \`codegraph node\` for caller/callee context and \`codegraph affected\`
to select focused tests. Fall back to \`rg\` and direct file reads for exact
wire text, configuration, and graph misses. CodeGraph is navigation evidence, not correctness evidence;
tests and executable feedback gates establish correctness.
`;
    for (const filename of ["implement-prompt.md", "review-prompt.md"]) {
      const promptPath = join(configDir, filename);
      const content = yield* fs
        .readFileString(promptPath)
        .pipe(Effect.mapError((e) => new Error(e.message)));
      const withStandardsMount = content.replaceAll(
        "@.sandcastle/CODING_STANDARDS.md",
        "/home/agent/CODING_STANDARDS.md",
      );
      let withFeedback = withStandardsMount;
      if (filename === "implement-prompt.md") {
        withFeedback = replaceRequired(
          withFeedback,
          `1. Read \`/home/agent/CODING_STANDARDS.md\` completely.
2. Inspect \`git status\`, the last ten commits, relevant package manifests,`,
          `1. Read \`/home/agent/CODING_STANDARDS.md\` completely.
2. Read \`/home/agent/FEEDBACK_LOOPS.md\` completely for executable
   bootstrap, focused-test, and authoritative-gate commands.
3. Inspect \`git status\`, the last ten commits, relevant package manifests,`,
        );
        withFeedback = replaceRequired(
          withFeedback,
          "one authoritative gate from `/home/agent/CODING_STANDARDS.md`",
          "one authoritative gate from `/home/agent/FEEDBACK_LOOPS.md`",
        );
      } else {
        withFeedback = replaceRequired(
          withFeedback,
          `\`/home/agent/CODING_STANDARDS.md\` completely before judging the change.`,
          `\`/home/agent/CODING_STANDARDS.md\` completely before judging the change.
Read \`/home/agent/FEEDBACK_LOOPS.md\` completely before selecting or running
any executable feedback command.`,
        );
        withFeedback = replaceRequired(
          withFeedback,
          `Run one authoritative gate from
   \`/home/agent/CODING_STANDARDS.md\``,
          `Run one authoritative gate from
   \`/home/agent/FEEDBACK_LOOPS.md\``,
        );
      }
      const updated = replaceRequired(
        withFeedback,
        "# EXPLORATION\n\n",
        `# EXPLORATION\n\n${guidance}\n`,
      );
      yield* fs
        .writeFileString(promptPath, updated)
        .pipe(Effect.mapError((e) => new Error(e.message)));
    }

    const mergePath = join(configDir, "merge-prompt.md");
    let merge = yield* fs
      .readFileString(mergePath)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    merge = merge.replaceAll(
      ".sandcastle/CODING_STANDARDS.md",
      "/home/agent/CODING_STANDARDS.md",
    );
    merge = replaceRequired(
      merge,
      `1. Read \`/home/agent/CODING_STANDARDS.md\` completely.
2. Confirm \`{{BATCH_BASE_SHA}}\` names the current pre-merge integration commit.
3. Inspect the listed branches and associated tasks:`,
      `1. Read \`/home/agent/CODING_STANDARDS.md\` completely.
2. Read \`/home/agent/FEEDBACK_LOOPS.md\` completely.
3. Confirm \`{{BATCH_BASE_SHA}}\` names the current pre-merge integration commit.
4. Inspect the listed branches and associated tasks:`,
    );
    merge = replaceRequired(
      merge,
      `After every listed branch has been merged:

1. List the complete change set with
   \`git diff --name-only {{BATCH_BASE_SHA}}...HEAD\`.
2. Map those paths to affected packages or modules using their manifests and
   build configuration.
3. Run every affected-package authoritative gate defined in
   \`/home/agent/CODING_STANDARDS.md\`, from the package directory and with its
   declared package manager or build tool.
4. Run focused integration or contract tests for boundaries touched by more
   than one merged branch.
5. Run \`git diff --check\` and inspect the cumulative diff and repository status
   for secrets, local state, generated-file mistakes, and unrelated churn.`,
      `After every listed branch has been merged, run the executable cumulative gate:

\`\`\`bash
bash .sandcastle/scripts/verify-affected.sh "{{BATCH_BASE_SHA}}"
\`\`\`

The script owns affected-package mapping and authoritative commands documented
in \`/home/agent/FEEDBACK_LOOPS.md\`. After it succeeds, inspect the cumulative
diff and repository status for secrets, local state, generated-file mistakes,
and unrelated churn.`,
    );
    yield* fs
      .writeFileString(mergePath, merge)
      .pipe(Effect.mapError((e) => new Error(e.message)));
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

const scaffoldIssueTrackerFiles = (
  configDir: string,
  templateName: string,
  issueTracker: IssueTrackerEntry,
  createLabel: boolean,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const plannerTemplate = [
      "parallel-planner",
      "parallel-planner-with-review",
      "codex-afk",
    ].includes(templateName);
    if (!plannerTemplate) {
      return;
    }

    const fs = yield* FileSystem.FileSystem;
    const inventoryCommand = createLabel
      ? issueTracker.templateArgs.PLANNER_LIST_TASKS_COMMAND
      : issueTracker.templateArgs.PLANNER_LIST_TASKS_COMMAND.replace(
          / --label Sandcastle/g,
          "",
        );
    const inventoryScript = `#!/usr/bin/env bash
set -euo pipefail
${inventoryCommand}
`;

    yield* fs
      .writeFileString(join(configDir, "planner-inventory.sh"), inventoryScript)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* fs
      .chmod(join(configDir, "planner-inventory.sh"), 0o755)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* fs
      .copyFile(
        join(getTemplatesDir(), "planner-batch.ts"),
        join(configDir, "planner-batch.ts"),
      )
      .pipe(Effect.mapError((e) => new Error(e.message)));

    if (issueTracker.name !== "github-issues") {
      const readinessPath = join(configDir, "readiness.json");
      if (yield* fs.exists(readinessPath)) {
        const config = JSON.parse(yield* fs.readFileString(readinessPath));
        yield* fs.writeFileString(
          readinessPath,
          JSON.stringify({ ...config, mode: "disabled" }, null, 2) + "\n",
        );
      }
      return;
    }
    yield* fs
      .copyFile(
        join(getTemplatesDir(), "github-planner-inventory.cjs"),
        join(configDir, "github-planner-inventory.cjs"),
      )
      .pipe(Effect.mapError((e) => new Error(e.message)));
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
  /** Authentication mode for Codex. ChatGPT uses a project-isolated OAuth home. */
  agentAuth?: "api-key" | "chatgpt";
  /** Pinned @colbymchenry/codegraph version used by the codex-afk image. */
  codeGraphVersion?: string;
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
      agentAuth = templateName === "codex-afk" ? "chatgpt" : "api-key",
      codeGraphVersion = "1.5.0",
    } = options;
    const fs = yield* FileSystem.FileSystem;
    const configDir = join(repoDir, ".sandcastle");
    const selectedTemplate = TEMPLATES.find((t) => t.name === templateName);
    const isCodexAfk = templateName === "codex-afk";
    const resolvedCodeGraphVersion = isCodexAfk
      ? yield* Effect.try({
          try: () => validateCodeGraphVersion(codeGraphVersion),
          catch: (error) =>
            error instanceof Error ? error : new Error(`${error}`),
        })
      : codeGraphVersion;
    const codexAfkProject = isCodexAfk
      ? yield* detectCodexAfkProjectProfile(repoDir)
      : undefined;

    if (selectedTemplate?.requiredAgent !== undefined) {
      if (selectedTemplate.requiredAgent !== agent.name) {
        yield* Effect.fail(
          new Error(
            `Template "${templateName}" requires agent "${selectedTemplate.requiredAgent}".`,
          ),
        );
      }
    }
    if (agentAuth === "chatgpt" && agent.name !== "codex") {
      yield* Effect.fail(
        new Error('Agent auth "chatgpt" is only supported by the Codex agent.'),
      );
    }

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
    const isolatedCodexHome = agentAuth === "chatgpt";

    if (isolatedCodexHome) {
      const codexHome = join(configDir, "codex-home");
      const codexConfig = join(codexHome, "config.toml");
      yield* fs
        .makeDirectory(codexHome, { recursive: true })
        .pipe(Effect.mapError((e) => new Error(e.message)));
      yield* fs
        .chmod(codexHome, 0o700)
        .pipe(Effect.mapError((e) => new Error(e.message)));
      yield* fs
        .writeFileString(codexConfig, CODEX_CHATGPT_CONFIG)
        .pipe(Effect.mapError((e) => new Error(e.message)));
      yield* fs
        .chmod(codexConfig, 0o600)
        .pipe(Effect.mapError((e) => new Error(e.message)));
    }

    // Build .env.example from agent + issue tracker env blocks
    const envExampleParts = [
      isolatedCodexHome ? CODEX_CHATGPT_ENV_EXAMPLE : agent.envExample,
    ];
    if (issueTracker.envExample) {
      envExampleParts.push(issueTracker.envExample);
    }
    const envExampleContent = envExampleParts.join("\n") + "\n";
    let containerfileContent = agent.dockerfileTemplate;
    if (isCodexAfk) {
      containerfileContent = addCodeGraphToContainerfile(
        containerfileContent,
        resolvedCodeGraphVersion,
      );
      if (codexAfkProject?.profile.projectType === "android") {
        containerfileContent = addAndroidToolchainToContainerfile(
          containerfileContent,
          codexAfkProject.profile,
        );
      }
    }

    yield* Effect.all(
      [
        fs
          .writeFileString(
            join(configDir, sandboxProvider.containerfileName),
            containerfileContent,
          )
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(
            join(configDir, ".gitignore"),
            gitignoreFor({
              isolatedCodexHome,
              codeGraph: isCodexAfk,
              projectCachePath: codexAfkProject?.profile.cache.hostPath,
            }),
          )
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".env.example"), envExampleContent)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        copyTemplateFiles(templateDir, configDir, mainFilename),
      ],
      { concurrency: "unbounded" },
    );

    yield* scaffoldIssueTrackerFiles(
      configDir,
      templateName,
      issueTracker,
      createLabel,
    );

    // Rewrite main file with the selected agent factory, model, and sandbox provider
    yield* rewriteMainTs(
      configDir,
      agent,
      model,
      sandboxProvider,
      mainFilename,
    );

    if (codexAfkProject !== undefined) {
      yield* rewriteCodexAfkMain(
        configDir,
        mainFilename,
        model,
        codexAfkProject.profile,
      );
      if (codexAfkProject.profile.projectType === "android") {
        yield* scaffoldAndroidGradleProjectProfile(configDir, {
          profile: codexAfkProject.profile,
          sources: codexAfkProject.sources,
        });
      } else {
        yield* scaffoldNodeNpmProjectProfile(configDir, {
          profile: codexAfkProject.profile,
          sources: codexAfkProject.sources,
        });
      }
    }

    // Replace issue tracker template arguments in all text files (must run before label stripping)
    yield* substituteTemplateArgs(configDir, issueTracker);

    // Strip --label Sandcastle from prompt files when the user declined label creation
    if (!createLabel) {
      yield* rewritePromptFiles(configDir);
    }

    if (isCodexAfk) {
      yield* configureCodexAfkPrompts(configDir);
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
