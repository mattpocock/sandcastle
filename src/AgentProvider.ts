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

export interface AgentProvider {
  readonly name: string;
  buildPrintCommand(prompt: string): string;
  buildPrintCommandFromStdin?(): string;
  buildInteractiveArgs(prompt: string): string[];
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

export const codex = (model: string): AgentProvider => ({
  name: "codex",

  buildPrintCommand(prompt: string): string {
    return `codex exec --json --dangerously-bypass-approvals-and-sandbox -m ${shellEscape(model)} ${shellEscape(prompt)}`;
  },

  buildPrintCommandFromStdin(): string {
    return `codex exec --json --dangerously-bypass-approvals-and-sandbox -m ${shellEscape(model)} -`;
  },

  buildInteractiveArgs(_prompt: string): string[] {
    return ["codex", "--model", model];
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseCodexStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// Claude Code agent provider
// ---------------------------------------------------------------------------

export interface ClaudeCodeOptions {
  readonly effort?: "low" | "medium" | "high" | "max";
}

export const claudeCode = (
  model: string,
  options?: ClaudeCodeOptions,
): AgentProvider => ({
  name: "claude-code",

  buildPrintCommand(prompt: string): string {
    const effortFlag = options?.effort ? ` --effort ${options.effort}` : "";
    return `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model ${shellEscape(model)}${effortFlag} -p ${shellEscape(prompt)}`;
  },

  buildInteractiveArgs(_prompt: string): string[] {
    const args = ["claude", "--dangerously-skip-permissions", "--model", model];
    if (options?.effort) args.push("--effort", options.effort);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseStreamJsonLine(line);
  },
});
