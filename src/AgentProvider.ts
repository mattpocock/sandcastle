import { SANDBOX_WORKSPACE_DIR } from "./SandboxFactory.js";

// ---------------------------------------------------------------------------
// Shared types used by providers and the orchestrator
// ---------------------------------------------------------------------------

export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly total_cost_usd: number;
  readonly num_turns: number;
  readonly duration_ms: number;
}

export type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string; usage: TokenUsage | null }
  | { type: "tool_call"; name: string; args: string };

// ---------------------------------------------------------------------------
// AgentProvider interface
// ---------------------------------------------------------------------------

export interface AgentProvider {
  readonly name: string;
  readonly envManifest: Record<string, string>;
  readonly dockerfileTemplate: string;
  readonly defaultModel: string;

  /**
   * Build the shell command for a non-interactive (print) agent invocation
   * inside the sandbox.
   */
  readonly buildPrintCommand: (opts: {
    model: string;
    prompt: string;
  }) => string;

  /**
   * Build the CLI arguments for an interactive agent session.
   * These are passed to `docker exec -it <container> <...args>`.
   */
  readonly buildInteractiveArgs: (opts: { model: string }) => string[];

  /**
   * Parse a single line of streaming output from the agent into display events.
   */
  readonly parseStreamLine: (line: string) => ParsedStreamEvent[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

// ---------------------------------------------------------------------------
// Claude Code provider
// ---------------------------------------------------------------------------

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

# Create a non-root user for the agent to run as
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

/** Maps allowlisted tool names to the input field containing the display arg */
const CLAUDE_TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

const extractClaudeUsage = (
  obj: Record<string, unknown>,
): TokenUsage | null => {
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (
    !usage ||
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    return null;
  }
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0,
    cache_creation_input_tokens:
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0,
    total_cost_usd:
      typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
    num_turns: typeof obj.num_turns === "number" ? obj.num_turns : 0,
    duration_ms: typeof obj.duration_ms === "number" ? obj.duration_ms : 0,
  };
};

/**
 * Parse a line of Claude Code's `stream-json` output format into display events.
 */
export const parseClaudeStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const events: ParsedStreamEvent[] = [];
      const texts: string[] = [];
      for (const block of obj.message.content as {
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[]) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          block.input !== undefined
        ) {
          const argField = CLAUDE_TOOL_ARG_FIELDS[block.name];
          if (argField === undefined) continue; // not allowlisted
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue; // missing/wrong arg field
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({
            type: "tool_call",
            name: block.name,
            args: argValue,
          });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      return [
        { type: "result", result: obj.result, usage: extractClaudeUsage(obj) },
      ];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

export const claudeCodeProvider: AgentProvider = {
  name: "claude-code",
  defaultModel: "claude-opus-4-6",

  envManifest: {
    ANTHROPIC_API_KEY: "Anthropic API key",
    GH_TOKEN: "GitHub personal access token",
  },

  dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,

  buildPrintCommand: ({ model, prompt }) =>
    `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model ${shellEscape(model)} -p ${shellEscape(prompt)}`,

  buildInteractiveArgs: ({ model }) => [
    "claude",
    "--dangerously-skip-permissions",
    "--model",
    model, // Interactive args are passed as array elements — no shell escaping needed
  ],

  parseStreamLine: parseClaudeStreamLine,
};

// ---------------------------------------------------------------------------
// Pi provider
// ---------------------------------------------------------------------------

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

# Create a non-root user for the agent to run as
RUN useradd -m -s /bin/bash agent
USER agent

# Configure npm global prefix for non-root installs
ENV NPM_CONFIG_PREFIX=/home/agent/.npm-global
ENV PATH="/home/agent/.npm-global/bin:$PATH"

# Install pi coding agent
RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_WORKSPACE_DIR}
# and overrides the working directory to ${SANDBOX_WORKSPACE_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_WORKSPACE_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

/**
 * Maps pi tool names to display name + arg field.
 * Pi uses lowercase names for built-in tools (e.g. "bash", "read", "edit").
 *
 * Currently only bash is allowlisted — other tools (read, edit, grep) are
 * filtered out to match Claude Code's display behavior. Expand this map
 * as pi's JSON event schema stabilizes.
 */
const PI_TOOL_DISPLAY: Record<
  string,
  { displayName: string; argField: string } | undefined
> = {
  bash: { displayName: "Bash", argField: "command" },
};

/**
 * Parse a line of pi's `--mode json` output format into display events.
 *
 * Pi emits JSONL events with types like `message_update`, `tool_execution_start`,
 * and `agent_end`. See the pi coding agent documentation for the full event schema.
 */
export const parsePiStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);

    // Text delta from assistant
    if (
      obj.type === "message_update" &&
      obj.assistantMessageEvent?.type === "text_delta" &&
      typeof obj.assistantMessageEvent.delta === "string"
    ) {
      return [{ type: "text", text: obj.assistantMessageEvent.delta }];
    }

    // Tool execution start — show allowlisted tools
    if (
      obj.type === "tool_execution_start" &&
      typeof obj.toolName === "string"
    ) {
      const mapping = PI_TOOL_DISPLAY[obj.toolName];
      if (
        mapping &&
        obj.args &&
        typeof obj.args[mapping.argField] === "string"
      ) {
        return [
          {
            type: "tool_call",
            name: mapping.displayName,
            args: obj.args[mapping.argField] as string,
          },
        ];
      }
    }

    // Agent end — extract final result text from the last assistant message
    if (obj.type === "agent_end" && Array.isArray(obj.messages)) {
      const messages = obj.messages as {
        role: string;
        content: { type: string; text?: string }[];
      }[];
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (lastAssistant && Array.isArray(lastAssistant.content)) {
        const text = lastAssistant.content
          .filter(
            (block) => block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("");
        if (text) {
          // Pi's JSON mode does not include token usage data in agent_end.
          return [{ type: "result", result: text, usage: null }];
        }
      }
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

export const piProvider: AgentProvider = {
  name: "pi",
  // Sonnet balances cost and capability for automated workflows.
  // The model can be overridden via RunOptions.
  defaultModel: "claude-sonnet-4-6",

  envManifest: {
    ANTHROPIC_API_KEY: "Anthropic API key",
    GH_TOKEN: "GitHub personal access token",
  },

  dockerfileTemplate: PI_DOCKERFILE,

  buildPrintCommand: ({ model, prompt }) =>
    `pi -p --mode json --no-session --model ${shellEscape(model)} ${shellEscape(prompt)}`,

  buildInteractiveArgs: ({ model }) => ["pi", "--model", model],

  parseStreamLine: parsePiStreamLine,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const AGENT_REGISTRY: Record<string, AgentProvider> = {
  "claude-code": claudeCodeProvider,
  pi: piProvider,
};

export const getAgentProvider = (name: string): AgentProvider => {
  const provider = AGENT_REGISTRY[name];
  if (!provider) {
    throw new Error(
      `Unknown agent provider: "${name}". Available providers: ${Object.keys(AGENT_REGISTRY).join(", ")}`,
    );
  }
  return provider;
};
