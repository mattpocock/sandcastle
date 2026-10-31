import { FileSystem } from "@effect/platform";
import { Effect, Option, Schema } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InitError } from "./errors.js";
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
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const PackageJson = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

/**
 * The host project's package.json, or None when it is missing, unreadable, or
 * not a JSON object.
 */
const readHostPackageJson = (
  repoDir: string,
): Effect.Effect<
  Option.Option<Record<string, unknown>>,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(repoDir, "package.json");
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none();
    }
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    return Schema.decodeUnknownOption(PackageJson)(content);
  });

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

    // A missing or malformed package.json falls through to lockfile detection.
    const pkg = yield* readHostPackageJson(repoDir);
    const field = Option.getOrUndefined(pkg)?.["packageManager"];
    if (typeof field === "string") {
      const name = field.split("@")[0];
      const match = PACKAGE_MANAGERS.find((pm) => pm === name);
      if (match) {
        return match;
      }
    }

    for (const [file, pm] of LOCKFILES) {
      const exists = yield* fs
        .exists(join(repoDir, file))
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        return pm;
      }
    }

    return "npm";
  });

/** Build the command that adds a runtime dependency for the given package manager. */
export const addDependencyCommand = (
  packageManager: PackageManager,
  pkg: string,
): string => {
  switch (packageManager) {
    case "pnpm": {
      return `pnpm add ${pkg}`;
    }
    case "yarn": {
      return `yarn add ${pkg}`;
    }
    case "bun": {
      return `bun add ${pkg}`;
    }
    case "npm": {
      return `npm install ${pkg}`;
    }
  }
};

/** Build the command that runs a package.json script for the given package manager. */
const runScriptCommand = (
  packageManager: PackageManager,
  script: string,
): string => `${packageManager} run ${script}`;

/** Build the command that installs all dependencies for the given package manager. */
const installCommand = (packageManager: PackageManager): string =>
  `${packageManager} install`;

/**
 * Whether the host package.json already declares `pkg` in any of its dependency
 * maps. Used so init doesn't offer to install something already present.
 */
export const hostHasDependency = (
  repoDir: string,
  pkg: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const parsed = yield* readHostPackageJson(repoDir);
    if (Option.isNone(parsed)) {
      return false;
    }
    const depMaps = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ];
    return depMaps.some((key) => {
      const deps = parsed.value[key];
      return typeof deps === "object" && deps !== null && pkg in deps;
    });
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

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
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

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
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
    envExample: `# OpenAI API key from platform.openai.com (\`codex exec\` reads CODEX_API_KEY)
CODEX_API_KEY=`,
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
# Copilot CLI reads COPILOT_GITHUB_TOKEN first, then GH_TOKEN, then GITHUB_TOKEN,
# so this key is used even when GH_TOKEN is set for the issue tracker.
COPILOT_GITHUB_TOKEN=`,
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
  /**
   * TypeScript source for a `sandboxOptions` object literal (comment included)
   * that the scaffolded main file passes to every sandbox provider call, or
   * undefined to leave the calls bare. For trackers whose state must reach
   * every sandbox, including worktree sandboxes, which get tracked files only.
   */
  readonly sandboxOptions?: string;
}

const GITHUB_CLI_TOOLS = `# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*`;

// The bd release baked into the beads image. 1.0.4 is the first release whose
// embedded backend lets several bd processes open one database at once (the
// parallel templates' sandboxes plus the host); 1.3.2 is the release this
// scaffold was verified with.
const BEADS_VERSION = "1.3.2";

// Every sandbox, including worktree sandboxes, mounts the host's .beads/ and
// points bd at it, so all phases share the one issue database.
const BEADS_SANDBOX_DIR = "/home/agent/host-beads";
const BEADS_SANDBOX_OPTIONS = `// Beads keeps its database in .beads/, which git ignores, so a worktree
// sandbox never gets it. Mount the host's .beads/ into every sandbox and point
// bd at it, so every phase reads and closes issues in the one shared database.
// Run this file from the repo root (hostPath is relative to the cwd).
const sandboxOptions = {
  mounts: [{ hostPath: ".beads", sandboxPath: "${BEADS_SANDBOX_DIR}" }],
  env: { BEADS_DIR: "${BEADS_SANDBOX_DIR}" },
};`;

const BEADS_TOOLS = `# Install system dependencies for Beads
RUN apt-get update && apt-get install -y \\
  dpkg-dev \\
  libicu72 \\
  && rm -rf /var/lib/apt/lists/* \\
  && ARCH_DIR=$(dpkg-architecture -qDEB_HOST_MULTIARCH) \\
  && for lib in /usr/lib/$ARCH_DIR/libicu*.so.72; do \\
       ln -s "$lib" "\${lib%.72}.74"; \\
     done

# Pinned bd release. Every sandbox opens your host's beads database (see
# sandboxOptions in main), so keep this equal to the host's \`bd version\`.
ARG BEADS_VERSION=${BEADS_VERSION}
RUN ARCH=$(dpkg --print-architecture) \\
  && BEADS_TARBALL="beads_\${BEADS_VERSION}_linux_\${ARCH}.tar.gz" \\
  && BEADS_URL="https://github.com/gastownhall/beads/releases/download/v\${BEADS_VERSION}" \\
  && cd /tmp \\
  && curl -fsSLO "\${BEADS_URL}/\${BEADS_TARBALL}" \\
  && curl -fsSL "\${BEADS_URL}/checksums.txt" | grep " \${BEADS_TARBALL}$" | sha256sum -c - \\
  && tar -xzf "\${BEADS_TARBALL}" -C /usr/local/bin bd \\
  && rm "\${BEADS_TARBALL}" \\
  && bd version

RUN corepack enable`;

/** `bd version` prints `bd version 1.3.2 (<commit>)`; returns `1.3.2`. */
export const parseBdVersion = (output: string): string | undefined =>
  /\bbd version v?(?<version>\d+\.\d+\.\d+)\b/u.exec(output)?.groups?.version;

const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
};

/**
 * What init warns a beads user about the host's bd, or undefined when it
 * matches the image's. Every beads sandbox opens the host's .beads/ with the
 * image's pinned bd. A newer bd migrates the database, after which an older
 * host bd can't create issues (`fk_events_issue`, or "Your bd binary is
 * stale"). init doesn't pin the image to the host's bd instead: the scaffold's
 * BEADS_DIR mount is verified on 1.3.2 only, and bd 1.2.2 with it silently
 * reads an empty database.
 */
export const beadsVersionWarning = (
  hostVersion?: string,
): string | undefined => {
  if (hostVersion === BEADS_VERSION) {
    return undefined;
  }
  const shared = `the image installs bd ${BEADS_VERSION}, and every sandbox opens your .beads/ with it`;
  if (hostVersion === undefined) {
    return `bd isn't on your PATH, and ${shared}. Use bd ${BEADS_VERSION} on the host too, or an older host bd can no longer create issues once a sandbox has opened the database.`;
  }
  if (compareVersions(hostVersion, BEADS_VERSION) < 0) {
    return `Your host runs bd ${hostVersion}, but ${shared}. bd ${BEADS_VERSION} migrates the database, after which host bd ${hostVersion} can no longer create issues in it. Upgrade the host's bd to ${BEADS_VERSION} before you run.`;
  }
  return `Your host runs bd ${hostVersion}, but ${shared}, and an older bd can't safely write a database a newer one has migrated. Set ARG BEADS_VERSION in the Dockerfile to ${hostVersion} and rebuild the image, or use bd ${BEADS_VERSION} on the host.`;
};

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

// A non-empty tuple type, so `[0]` (the default) is known to exist.
const ISSUE_TRACKER_REGISTRY: [IssueTrackerEntry, ...IssueTrackerEntry[]] = [
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
    sandboxOptions: BEADS_SANDBOX_OPTIONS,
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

/** How init scaffolds and builds the image an image-based provider runs. */
export interface SandboxProviderImage {
  /** Filename written to .sandcastle/ (e.g. "Dockerfile" or "Containerfile") */
  readonly containerfileName: string;
  /** CLI namespace for build/remove commands (e.g. "docker" or "podman") */
  readonly cliNamespace: string;
}

export interface SandboxProviderEntry {
  readonly name: string;
  readonly label: string;
  /**
   * The provider's image, or undefined for a provider that runs without one.
   * Every image-specific init step (containerfile scaffold, build-image
   * prompt and flag, `imageName` rewrite, build-image next step, beads
   * version warning) runs only when this is set.
   */
  readonly image?: SandboxProviderImage;
}

// A non-empty tuple type, so `[0]` (the default) is known to exist.
const SANDBOX_PROVIDER_REGISTRY: [
  SandboxProviderEntry,
  ...SandboxProviderEntry[],
] = [
  {
    name: "docker",
    label: "Docker",
    image: { containerfileName: "Dockerfile", cliNamespace: "docker" },
  },
  {
    name: "podman",
    label: "Podman",
    image: { containerfileName: "Containerfile", cliNamespace: "podman" },
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

export const getNextStepsLines = (
  template: string,
  mainFilename: string,
  issueTracker: IssueTrackerEntry,
  agent: AgentEntry,
  packageManager: PackageManager,
  /** Template dependencies the host already has (declared, or installed by init). */
  installedDependencies: readonly string[],
  /** The chosen sandbox provider. Defaults to the first (Docker). */
  sandboxProvider: SandboxProviderEntry = SANDBOX_PROVIDER_REGISTRY[0],
): string[] => {
  const runStep = `Run \`${runScriptCommand(packageManager, "sandcastle")}\` to start the agent`;
  // The custom issue tracker scaffolds a broken-until-configured project, so
  // its next steps are about running the setup prompt — not the template's
  // normal "set env vars and go" flow. This branch wins over template-specific
  // steps regardless of the chosen template.
  if (issueTracker.name === "custom") {
    const hasImage = sandboxProvider.image !== undefined;
    return [
      "Next steps:",
      "1. Your custom issue tracker isn't wired up yet — runs hard-fail until you configure it.",
      `2. Feed the setup prompt to ${agent.label} on your host to finish wiring it up:`,
      `   ${agent.setupCommand}`,
      hasImage
        ? `   (Runs on the host — you need the ${agent.label} CLI installed locally, since the sandbox image isn't built yet.)`
        : `   (Runs on the host — you need the ${agent.label} CLI installed locally.)`,
      hasImage
        ? `3. Follow .sandcastle/${SETUP_ISSUE_TRACKER_DOC} to edit the scaffolded files in place, build the image, and verify.`
        : `3. Follow .sandcastle/${SETUP_ISSUE_TRACKER_DOC} to edit the scaffolded files in place and verify.`,
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
      `5. ${runStep}`,
    );
    return lines;
  }
  const hasReviewer = template.includes("review");
  const needsPlanSchema =
    getTemplateDependencies(template).includes("zod") &&
    !installedDependencies.includes("zod");
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
    `${step++}. Templates use \`copyToWorktree: ["node_modules"]\` to copy your host node_modules into the sandbox for fast startup — the \`npm install\` in the onSandboxReady hook is a safety net for platform-specific binaries. ${
      packageManager === "npm"
        ? "Adjust both if you use a different package manager"
        : `This project uses ${packageManager}, so change the hook to \`${installCommand(packageManager)}\` and check \`copyToWorktree\` suits it`
    }`,
  );
  if (needsPlanSchema) {
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
  lines.push(`${step++}. ${runStep}`);
  return lines;
};

// ---------------------------------------------------------------------------
// Scaffolding helpers
// ---------------------------------------------------------------------------

const getTemplatesDir = (): string => {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "templates");
};

const getTemplateDir = (
  templateName: string,
): Effect.Effect<string, InitError> =>
  Effect.gen(function* () {
    const template = TEMPLATES.find((t) => t.name === templateName);
    if (!template) {
      const names = TEMPLATES.map((t) => t.name).join(", ");
      return yield* new InitError({
        message: `Unknown template: "${templateName}". Available: ${names}`,
      });
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
): Effect.Effect<void, InitError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(templateDir)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
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
            .pipe(
              Effect.mapError((e) => new InitError({ message: e.message })),
            );
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
  imageName: string | undefined,
): Effect.Effect<void, InitError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mainTsPath = join(configDir, mainFilename);

    const exists = yield* fs
      .exists(mainTsPath)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
    if (!exists) {
      return;
    }

    let content = yield* fs
      .readFileString(mainTsPath)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));

    // Templates use main.mts as the canonical filename in comments.
    // When the target is main.ts, rewrite those references.
    if (mainFilename === "main.ts") {
      content = content.replaceAll("main.mts", "main.ts");
    }

    // Replace factory function name in imports (e.g. claudeCode → pi)
    // and all factory calls with the correct model.
    // Templates always use claudeCode as the placeholder factory.
    content = content.replaceAll(/\bclaudeCode\b/g, agent.factoryImport);
    // Replace model strings in factory calls: factoryImport("any-model")
    const factoryCallRe = new RegExp(
      `${agent.factoryImport}\\(["']([^"']+)["']\\)`,
      "g",
    );
    content = content.replaceAll(
      factoryCallRe,
      `${agent.factoryImport}("${model}")`,
    );

    // Replace the sandbox provider. Templates always use `docker` as the
    // placeholder, where the registry name doubles as both the factory function
    // name and the `/sandboxes/<name>` import subpath segment. A single
    // case-sensitive word-boundary replace therefore rewrites the named import,
    // the import subpath, and every factory call site — and is a no-op when
    // docker is selected.
    content = content.replaceAll(/\bdocker\b/g, sandboxProvider.name);

    // A custom image name (init --image-name) must reach every sandbox factory
    // call, or the scaffolded run starts the default-named image instead of
    // the one init built.
    if (imageName !== undefined && sandboxProvider.image !== undefined) {
      content = content.replaceAll(
        new RegExp(`\\b${sandboxProvider.name}\\(\\)`, "g"),
        `${sandboxProvider.name}({ imageName: ${JSON.stringify(imageName)} })`,
      );
    }

    yield* fs
      .writeFileString(mainTsPath, content)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
  });

/**
 * Pass the issue tracker's `sandboxOptions` (if any) to every sandbox provider
 * call in a scaffolded main file: declare the options after the provider
 * import, then rewrite each bare `<provider>()` call to
 * `<provider>(sandboxOptions)`. Runs after `rewriteMainTs`, so the provider
 * name is already the selected one.
 */
const applyIssueTrackerSandboxOptions = (
  configDir: string,
  issueTracker: IssueTrackerEntry,
  sandboxProvider: SandboxProviderEntry,
  mainFilename: string,
): Effect.Effect<void, InitError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (!issueTracker.sandboxOptions) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const mainTsPath = join(configDir, mainFilename);

    const exists = yield* fs
      .exists(mainTsPath)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
    if (!exists) {
      return;
    }

    const content = yield* fs
      .readFileString(mainTsPath)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));

    const provider = sandboxProvider.name;
    const importRe = new RegExp(
      `^import \\{ ${provider} \\} from "@ai-hero/sandcastle/sandboxes/${provider}";$`,
      "m",
    );
    if (!importRe.test(content)) {
      return yield* new InitError({
        message: `Cannot apply ${issueTracker.label} sandbox options: ${mainFilename} has no ${provider} import.`,
      });
    }

    const updated = content
      .replace(importRe, (line) => `${line}\n\n${issueTracker.sandboxOptions}`)
      .replaceAll(
        new RegExp(`\\b${provider}\\(\\)`, "g"),
        `${provider}(sandboxOptions)`,
      );

    yield* fs
      .writeFileString(mainTsPath, updated)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
  });

/**
 * When the user opted out of the Sandcastle label, strip ` --label Sandcastle`
 * from all `.md` files in the scaffolded config directory so that `gh issue list`
 * commands work without a label filter.
 */
const rewritePromptFiles = (
  configDir: string,
): Effect.Effect<void, InitError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    yield* Effect.all(
      mdFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          const content = yield* fs
            .readFileString(filePath)
            .pipe(
              Effect.mapError((e) => new InitError({ message: e.message })),
            );
          const updated = content.replaceAll(" --label Sandcastle", "");
          if (updated !== content) {
            yield* fs
              .writeFileString(filePath, updated)
              .pipe(
                Effect.mapError((e) => new InitError({ message: e.message })),
              );
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
  ) {
    return true;
  }
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) {
    return false;
  }
  return TEXT_FILE_EXTENSIONS.has(filename.slice(dotIdx));
};

/**
 * Replace `{{KEY}}` template arguments from the issue tracker's
 * `templateArgs` map in all text files in the scaffolded config directory.
 */
const substituteTemplateArgs = (
  configDir: string,
  issueTracker: IssueTrackerEntry,
): Effect.Effect<void, InitError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
    const textFiles = files.filter((f) => isTextFile(f));
    yield* Effect.all(
      textFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          let content = yield* fs
            .readFileString(filePath)
            .pipe(
              Effect.mapError((e) => new InitError({ message: e.message })),
            );
          const original = content;
          for (const [key, value] of Object.entries(
            issueTracker.templateArgs,
          )) {
            content = content.replaceAll(
              new RegExp(`\\{\\{${key}\\}\\}`, "g"),
              value,
            );
          }
          if (content !== original) {
            yield* fs
              .writeFileString(filePath, content)
              .pipe(
                Effect.mapError((e) => new InitError({ message: e.message })),
              );
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
/**
 * The `sandcastle <provider> build-image` command that builds the image the
 * scaffolded main file runs, including `--image-name` when one was chosen.
 */
export const buildImageShellCommand = (
  image: SandboxProviderImage,
  imageName?: string,
): string =>
  `sandcastle ${image.cliNamespace} build-image${
    imageName === undefined ? "" : ` --image-name ${imageName}`
  }`;

const buildSetupIssueTrackerDoc = (
  /** The build-image command, or undefined for a provider with no image. */
  buildCommand: string | undefined,
): string =>
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

${
  buildCommand === undefined
    ? ""
    : `- **Dockerfile / Containerfile** — replace the line

  \`\`\`
  ${CUSTOM_TRACKER_TOOLS}
  \`\`\`

  with the install steps for your tracker's CLI (if it needs one).

`
}- **Prompt files (\`.sandcastle/*.md\`)** — replace the sentinel

  \`\`\`
  ${CUSTOM_LIST_TASKS_SENTINEL}
  \`\`\`

  with your **list** command. In the prompt file the sentinel sits inside a Sandcastle **shell expression** — a leading \`!\` followed by the command in backticks — whose output is injected into the prompt before each run. Keep that \`!\` and the surrounding backticks; replace only the command between them, and **remove the \`exit 1\`** (leaving it keeps every run hard-failing). Then replace the \`${CUSTOM_VIEW_TASK_MARKER}\` and \`${CUSTOM_CLOSE_TASK_MARKER}\` markers with your **view** and **close** commands.

- **\`.env.example\`** — replace the \`# TODO\` block with the real env var(s) your tracker needs, then tell the user to set them in \`.sandcastle/.env\`.

${
  buildCommand === undefined
    ? `## 4. Verify

Run your **list** command and confirm it returns the open tasks as JSON. If it errors, fix the command or the auth.
`
    : `## 4. Build the image

Once the files are wired up, build the sandbox image:

\`\`\`
${buildCommand}
\`\`\`

## 5. Verify

Run your **list** command inside the built image and confirm it returns the open tasks as JSON. If it errors, fix the command or the auth and rebuild.
`
}`;

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
  /**
   * Custom image name (`init --image-name`). When set, every sandbox factory
   * call in the main file is scaffolded as `<provider>({ imageName })`.
   * Omit to keep the provider's default, repo-scoped image name.
   */
  imageName?: string;
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
    const pkg = yield* readHostPackageJson(repoDir);
    return Option.getOrUndefined(pkg)?.["type"] === "module"
      ? "main.ts"
      : "main.mts";
  });

export const scaffold = (
  repoDir: string,
  options: ScaffoldOptions,
): Effect.Effect<ScaffoldResult, InitError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const {
      agent,
      model,
      templateName = "blank",
      createLabel = true,
      issueTracker = ISSUE_TRACKER_REGISTRY[0], // default: github-issues
      sandboxProvider = SANDBOX_PROVIDER_REGISTRY[0], // default: docker
      imageName,
    } = options;
    const fs = yield* FileSystem.FileSystem;
    const configDir = join(repoDir, ".sandcastle");

    const exists = yield* fs
      .exists(configDir)
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
    if (exists) {
      return yield* new InitError({
        message:
          ".sandcastle/ directory already exists. Remove it first if you want to re-initialize.",
      });
    }

    const mainFilename = yield* detectMainFilename(repoDir);

    yield* fs
      .makeDirectory(configDir, { recursive: false })
      .pipe(Effect.mapError((e) => new InitError({ message: e.message })));

    const templateDir = yield* getTemplateDir(templateName);

    // Build .env.example from agent + issue tracker env blocks
    const envExampleParts = [agent.envExample];
    if (issueTracker.envExample) {
      envExampleParts.push(issueTracker.envExample);
    }
    const envExampleContent = `${envExampleParts.join("\n")}\n`;

    const { image } = sandboxProvider;
    yield* Effect.all(
      [
        ...(image === undefined
          ? []
          : [
              fs
                .writeFileString(
                  join(configDir, image.containerfileName),
                  agent.dockerfileTemplate,
                )
                .pipe(
                  Effect.mapError((e) => new InitError({ message: e.message })),
                ),
            ]),
        fs
          .writeFileString(join(configDir, ".gitignore"), GITIGNORE)
          .pipe(Effect.mapError((e) => new InitError({ message: e.message }))),
        fs
          .writeFileString(join(configDir, ".env.example"), envExampleContent)
          .pipe(Effect.mapError((e) => new InitError({ message: e.message }))),
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
      imageName,
    );

    // Pass the issue tracker's sandbox options to every sandbox provider call
    yield* applyIssueTrackerSandboxOptions(
      configDir,
      issueTracker,
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
          buildSetupIssueTrackerDoc(
            image === undefined
              ? undefined
              : buildImageShellCommand(image, imageName),
          ),
        )
        .pipe(Effect.mapError((e) => new InitError({ message: e.message })));
    }

    return { mainFilename };
  });
