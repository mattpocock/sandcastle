export type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string }
  | { type: "tool_call"; name: string; args: string };

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

/** Maps allowlisted tool names to the input field containing the display arg */
const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

const parseStreamJsonLine = (line: string): ParsedStreamEvent[] => {
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
          const argField = TOOL_ARG_FIELDS[block.name];
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
      return [{ type: "result", result: obj.result }];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options passed to buildPrintCommand and buildInteractiveArgs. */
export interface AgentCommandOptions {
  readonly prompt: string;
  readonly dangerouslySkipPermissions: boolean;
}

export interface AgentProvider {
  readonly name: string;
  /** Environment variables injected by this agent provider. Merged at launch time with env resolver and sandbox provider env. */
  readonly env: Record<string, string>;
  buildPrintCommand(options: AgentCommandOptions): string;
  buildInteractiveArgs?(options: AgentCommandOptions): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];
}

export const DEFAULT_MODEL = "claude-opus-4-6";

// ---------------------------------------------------------------------------
// Pi agent provider
// ---------------------------------------------------------------------------

const parsePiStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "message_update" && obj.assistantMessageEvent) {
      const evt = obj.assistantMessageEvent as {
        type: string;
        delta?: string;
      };
      if (evt.type === "text_delta" && typeof evt.delta === "string") {
        return [{ type: "text", text: evt.delta }];
      }
      return [];
    }
    if (obj.type === "tool_execution_start") {
      const toolName = obj.toolName;
      if (typeof toolName !== "string") return [];
      const argField = TOOL_ARG_FIELDS[toolName];
      if (argField === undefined) return [];
      const args = obj.args as Record<string, unknown> | undefined;
      if (!args) return [];
      const argValue = args[argField];
      if (typeof argValue !== "string") return [];
      return [{ type: "tool_call", name: toolName, args: argValue }];
    }
    if (obj.type === "agent_end" && Array.isArray(obj.messages)) {
      const messages = obj.messages as {
        role: string;
        content: { type: string; text?: string }[];
      }[];
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === "assistant") {
          const texts: string[] = [];
          for (const block of msg.content) {
            if (block.type === "text" && typeof block.text === "string") {
              texts.push(block.text);
            }
          }
          if (texts.length > 0) {
            return [{ type: "result", result: texts.join("") }];
          }
          break;
        }
      }
      return [];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the pi agent provider. */
export interface PiOptions {
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const pi = (model: string, options?: PiOptions): AgentProvider => ({
  name: "pi",
  env: options?.env ?? {},

  buildPrintCommand({ prompt }: AgentCommandOptions): string {
    return `pi -p --mode json --no-session --model ${shellEscape(model)} ${shellEscape(prompt)}`;
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["pi", "--model", model];
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parsePiStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// Codex agent provider
// ---------------------------------------------------------------------------

const parseCodexStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);

    // item.completed with agent_message → text + result
    if (
      obj.type === "item.completed" &&
      obj.item?.type === "agent_message" &&
      typeof obj.item.content === "string"
    ) {
      const text = obj.item.content;
      return [
        { type: "text", text },
        { type: "result", result: text },
      ];
    }

    // item.started with command_execution → tool call
    if (
      obj.type === "item.started" &&
      obj.item?.type === "command_execution" &&
      typeof obj.item.command === "string"
    ) {
      return [{ type: "tool_call", name: "Bash", args: obj.item.command }];
    }

    // turn.completed → skip
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

const parseOpenCodeStreamLine = (
  line: string,
  accumulatedText: string,
): { events: ParsedStreamEvent[]; accumulatedText: string } => {
  if (!line.startsWith("{")) return { events: [], accumulatedText };
  try {
    const obj = JSON.parse(line);

    if (obj.type === "text" && typeof obj.part?.text === "string") {
      return {
        events: [{ type: "text", text: obj.part.text }],
        accumulatedText: accumulatedText + obj.part.text,
      };
    }

    if (obj.type === "step_finish" && accumulatedText.length > 0) {
      return {
        events: [{ type: "result", result: accumulatedText }],
        accumulatedText,
      };
    }

    if (obj.type === "tool_use" && typeof obj.part?.tool === "string") {
      let displayName: keyof typeof TOOL_ARG_FIELDS | undefined;
      switch (obj.part.tool) {
        case "bash":
          displayName = "Bash";
          break;
        case "webfetch":
          displayName = "WebFetch";
          break;
        case "websearch":
          displayName = "WebSearch";
          break;
        case "agent":
          displayName = "Agent";
          break;
      }
      if (displayName === undefined) {
        return { events: [], accumulatedText };
      }

      const argField = TOOL_ARG_FIELDS[displayName];
      if (argField === undefined) {
        return { events: [], accumulatedText };
      }
      const input = obj.part?.state?.input as
        | Record<string, unknown>
        | undefined;
      if (!input) return { events: [], accumulatedText };

      const argValue = input[argField];
      if (typeof argValue !== "string") {
        return { events: [], accumulatedText };
      }

      return {
        events: [{ type: "tool_call", name: displayName, args: argValue }],
        accumulatedText,
      };
    }
  } catch {
    // Not valid JSON — skip
  }
  return { events: [], accumulatedText };
};

/** Options for the codex agent provider. */
export interface CodexOptions {
  readonly effort?: "low" | "medium" | "high" | "xhigh";
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const codex = (
  model: string,
  options?: CodexOptions,
): AgentProvider => ({
  name: "codex",
  env: options?.env ?? {},

  buildPrintCommand({ prompt }: AgentCommandOptions): string {
    const effortFlag = options?.effort
      ? ` -c ${shellEscape(`model_reasoning_effort="${options.effort}"`)}`
      : "";
    return `codex exec --json --dangerously-bypass-approvals-and-sandbox -m ${shellEscape(model)}${effortFlag} ${shellEscape(prompt)}`;
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["codex", "--model", model];
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseCodexStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// OpenCode agent provider
// ---------------------------------------------------------------------------

/** Options for the opencode agent provider. */
export interface OpenCodeOptions {
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const opencode = (
  model: string,
  options?: OpenCodeOptions,
): AgentProvider => {
  let accumulatedText = "";

  return {
    name: "opencode",
    env: options?.env ?? {},

    buildPrintCommand({ prompt }: AgentCommandOptions): string {
      accumulatedText = "";
      return `opencode run --format json --model ${shellEscape(model)} ${shellEscape(prompt)}`;
    },

    buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
      const args = ["opencode", "--model", model];
      if (prompt) args.push("-p", prompt);
      return args;
    },

    parseStreamLine(line: string): ParsedStreamEvent[] {
      const parsed = parseOpenCodeStreamLine(line, accumulatedText);
      accumulatedText = parsed.accumulatedText;
      return parsed.events;
    },
  };
};

// ---------------------------------------------------------------------------
// Claude Code agent provider
// ---------------------------------------------------------------------------

export interface ClaudeCodeOptions {
  readonly effort?: "low" | "medium" | "high" | "max";
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const claudeCode = (
  model: string,
  options?: ClaudeCodeOptions,
): AgentProvider => ({
  name: "claude-code",
  env: options?.env ?? {},

  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): string {
    const skipPerms = dangerouslySkipPermissions
      ? " --dangerously-skip-permissions"
      : "";
    const effortFlag = options?.effort ? ` --effort ${options.effort}` : "";
    return `claude --print --verbose${skipPerms} --output-format stream-json --model ${shellEscape(model)}${effortFlag} -p ${shellEscape(prompt)}`;
  },

  buildInteractiveArgs({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): string[] {
    const args = ["claude"];
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    args.push("--model", model);
    if (options?.effort) args.push("--effort", options.effort);
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseStreamJsonLine(line);
  },
});
