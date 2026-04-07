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

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const extractUsage = (obj: Record<string, unknown>): TokenUsage | null => {
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
      return [{ type: "result", result: obj.result, usage: extractUsage(obj) }];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

export interface AgentProvider {
  readonly name: string;
  buildPrintCommand(prompt: string): string;
  buildInteractiveArgs(prompt: string): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];
  /** Shell command to verify the agent binary is available inside the sandbox. */
  buildValidateCommand(): string;
}

export const DEFAULT_MODEL = "claude-opus-4-6";

// ---------------------------------------------------------------------------
// Pi agent provider
// ---------------------------------------------------------------------------

const parsePiStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "message_update" && Array.isArray(obj.content)) {
      const texts: string[] = [];
      for (const block of obj.content as {
        type: string;
        text?: string;
      }[]) {
        if (block.type === "text_delta" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) {
        return [{ type: "text", text: texts.join("") }];
      }
      return [];
    }
    if (obj.type === "tool_execution_start") {
      const toolName = obj.tool_name;
      if (typeof toolName !== "string") return [];
      const argField = TOOL_ARG_FIELDS[toolName];
      if (argField === undefined) return [];
      const input = obj.input as Record<string, unknown> | undefined;
      if (!input) return [];
      const argValue = input[argField];
      if (typeof argValue !== "string") return [];
      return [{ type: "tool_call", name: toolName, args: argValue }];
    }
    if (
      obj.type === "agent_end" &&
      typeof obj.last_assistant_message === "string"
    ) {
      return [
        {
          type: "result",
          result: obj.last_assistant_message,
          usage: extractUsage(obj),
        },
      ];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

export const pi = (model: string): AgentProvider => ({
  name: "pi",

  buildPrintCommand(prompt: string): string {
    return `pi -p --mode json --no-session --model ${shellEscape(model)} ${shellEscape(prompt)}`;
  },

  buildInteractiveArgs(_prompt: string): string[] {
    return ["pi", "--model", model];
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parsePiStreamLine(line);
  },

  buildValidateCommand(): string {
    return "which pi";
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
        { type: "result", result: text, usage: extractUsage(obj) },
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

export const codex = (model: string): AgentProvider => ({
  name: "codex",

  buildPrintCommand(prompt: string): string {
    return `codex exec --json --dangerously-bypass-approvals-and-sandbox -m ${shellEscape(model)} ${shellEscape(prompt)}`;
  },

  buildInteractiveArgs(_prompt: string): string[] {
    return ["codex", "--model", model];
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseCodexStreamLine(line);
  },

  buildValidateCommand(): string {
    return "which codex";
  },
});

// ---------------------------------------------------------------------------
// Claude Code agent provider
// ---------------------------------------------------------------------------

export const claudeCode = (model: string): AgentProvider => ({
  name: "claude-code",

  buildPrintCommand(prompt: string): string {
    return `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model ${shellEscape(model)} -p ${shellEscape(prompt)}`;
  },

  buildInteractiveArgs(_prompt: string): string[] {
    return ["claude", "--dangerously-skip-permissions", "--model", model];
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseStreamJsonLine(line);
  },

  buildValidateCommand(): string {
    return "which claude";
  },
});
