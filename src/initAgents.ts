import { FileSystem } from "@effect/platform";
import { Config, Effect } from "effect";
import { delimiter, join } from "node:path";
import type { SandboxProviderEntry } from "./initSandboxProviders.js";

/** An agent `sandcastle init` offers, and what it scaffolds for it. */
export interface AgentEntry {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  /** The agent factory the main file imports from `@ai-hero/sandcastle/v1`. */
  readonly factoryImport: string;
  /** Lines to include in the generated `.env.example` for this agent's API key. */
  readonly envExample: string;
  /**
   * The agent's CLI on the host: the executable a provider that runs the
   * host's own programs needs on the host `PATH`, and the command that
   * installs it. Init warns with `install` when `command` is missing.
   */
  readonly hostCli: { readonly command: string; readonly install: string };
}

const AGENT_REGISTRY: readonly AgentEntry[] = [
  {
    name: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-8",
    factoryImport: "claudeCode",
    envExample: `# Claude Code OAuth token — get one by running \`claude setup-token\` on your host.
# Lets the agent use your Claude subscription instead of an API key.
CLAUDE_CODE_OAUTH_TOKEN=
# Or use an Anthropic API key instead — uncomment and fill in:
# ANTHROPIC_API_KEY=`,
    hostCli: {
      command: "claude",
      install: "curl -fsSL https://claude.ai/install.sh | bash",
    },
  },
  {
    name: "pi",
    label: "Pi",
    defaultModel: "claude-sonnet-4-6",
    factoryImport: "pi",
    envExample: `# Anthropic API key
ANTHROPIC_API_KEY=`,
    hostCli: {
      command: "pi",
      install: "npm install -g @earendil-works/pi-coding-agent",
    },
  },
  {
    name: "codex",
    label: "Codex",
    defaultModel: "gpt-5.4",
    factoryImport: "codex",
    envExample: `# OpenAI API key from platform.openai.com (\`codex exec\` reads CODEX_API_KEY)
CODEX_API_KEY=`,
    hostCli: {
      command: "codex",
      install: "npm install -g @openai/codex",
    },
  },
  {
    name: "cursor",
    label: "Cursor",
    defaultModel: "composer-2",
    factoryImport: "cursor",
    envExample: `# Cursor API key (recommended)
# You can also pass --api-key directly to the agent CLI.
CURSOR_API_KEY=`,
    hostCli: {
      command: "agent",
      install: "curl https://cursor.com/install -fsS | bash",
    },
  },
  {
    name: "opencode",
    label: "OpenCode",
    defaultModel: "opencode/big-pickle",
    factoryImport: "opencode",
    envExample: `# OpenCode API key
OPENCODE_API_KEY=`,
    hostCli: {
      command: "opencode",
      install: "npm install -g opencode-ai@latest",
    },
  },
  {
    name: "copilot",
    label: "GitHub Copilot CLI",
    defaultModel: "claude-sonnet-4.5",
    factoryImport: "copilot",
    envExample: `# GitHub token with the "Copilot Requests" permission
# (a fine-grained PAT, or any token from \`gh auth login\`).
# Copilot CLI reads COPILOT_GITHUB_TOKEN first, then GH_TOKEN, then GITHUB_TOKEN.
COPILOT_GITHUB_TOKEN=`,
    hostCli: {
      command: "copilot",
      install: "npm install -g @github/copilot",
    },
  },
];

export const listAgents = (): readonly AgentEntry[] => AGENT_REGISTRY;

export const getAgent = (name: string): AgentEntry | undefined =>
  AGENT_REGISTRY.find((a) => a.name === name);

/** True when `candidate` is a file (or a symlink to one). */
const isFile = (
  fs: FileSystem.FileSystem,
  candidate: string,
): Effect.Effect<boolean> =>
  fs.stat(candidate).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );

/** True when a file named `command` is in one of the host `PATH` dirs. */
const isOnHostPath = (
  command: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathValue = yield* Config.string("PATH").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    const pathExt = yield* Config.string("PATHEXT").pipe(
      Config.withDefault(".EXE;.CMD;.BAT"),
      Effect.orElseSucceed(() => ""),
    );
    const extensions =
      process.platform === "win32" ? ["", ...pathExt.split(";")] : [""];
    const candidates = pathValue
      .split(delimiter)
      .filter((dir) => dir !== "")
      .flatMap((dir) => extensions.map((ext) => join(dir, `${command}${ext}`)));
    const found = yield* Effect.all(
      candidates.map((candidate) => isFile(fs, candidate)),
      { concurrency: "unbounded" },
    );
    return found.includes(true);
  });

/**
 * What init warns a user whose provider runs the host's own programs, when
 * the agent CLI isn't on the host `PATH`, or undefined when it is. Without
 * it, the first session fails inside the sandbox.
 */
export const agentCliWarning = (
  agent: AgentEntry,
  sandboxProvider: SandboxProviderEntry,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.map(isOnHostPath(agent.hostCli.command), (found) =>
    found
      ? undefined
      : `The ${agent.label} CLI (\`${agent.hostCli.command}\`) isn't on your PATH, and ${sandboxProvider.name}() runs the host's own agent CLI. Install it with: ${agent.hostCli.install}`,
  );
